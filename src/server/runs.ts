import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../browser/chrome.js';
import { runAgent } from '../agent.js';
import { JevProvider } from '../providers/jev.js';
import { TextModelProvider } from '../providers/text.js';
import { buildActionSpace } from '../providers/action-space.js';
import { serveFixture } from '../../examples/fixture.js';
import type { Decision, DecisionProvider, ProgressSink, RunResult } from '../types.js';

export interface RunInput { url: string; goal: string; maxSteps: number; demo: boolean }
export interface RunEvent { id: number; time: string; type: string; attempt?: number; data: unknown }
export interface RunSummary extends RunInput { id: string; status: string; createdAt: string; traceError?: string }
export class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
export function parseRunInput(value: unknown): RunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'Expected a JSON object');
  const input = value as Record<string, unknown>;
  if (input.demo !== undefined && typeof input.demo !== 'boolean') throw new RequestError(400, 'demo must be a boolean');
  const demo = input.demo === true;
  let url: URL;
  try { url = new URL(demo ? 'http://127.0.0.1' : String(input.url ?? '')); } catch { throw new RequestError(400, 'Enter a valid starting URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RequestError(400, 'Use an HTTP(S) URL without credentials');
  const goal = demo ? 'Submit the contact form for Ada with topic Demo.' : typeof input.goal === 'string' ? input.goal.trim() : '';
  if (!goal || goal.length > 4000) throw new RequestError(400, 'Goal must contain 1–4000 characters');
  const maxSteps = input.maxSteps ?? 30;
  if (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50) throw new RequestError(400, 'Step budget must be 1–50');
  return { url: url.href, goal, maxSteps, demo };
}
interface Run { summary: RunSummary; events: RunEvent[]; controller: AbortController; finished: Promise<void> }
export class RunService {
  readonly updates = new EventEmitter();
  private runs = new Map<string, Run>();
  private active: string | undefined;
  constructor(private env: NodeJS.ProcessEnv = process.env, private traceDir = 'artifacts/runs') {}
  get configured() { return !!(this.env.TYPESAFE_API_KEY && this.env.TEXT_MODEL_API_KEY && this.env.TEXT_MODEL); }
  list(): RunSummary[] { return [...this.runs.values()].map(run => run.summary).reverse(); }
  get(id: string): Run { const run = this.runs.get(id); if (!run) throw new RequestError(404, 'Run not found'); return run; }
  start(input: RunInput): RunSummary {
    if (this.active) throw new RequestError(409, 'A run is already active. Stop it or wait for completion.');
    if (!input.demo && !this.configured) throw new RequestError(400, 'Set TYPESAFE_API_KEY, TEXT_MODEL_API_KEY, and TEXT_MODEL in .env, then restart the panel.');
    mkdirSync(this.traceDir, { recursive: true, mode: 0o700 });
    if (this.runs.size >= 10) this.runs.delete(this.runs.keys().next().value!);
    const id = randomUUID();
    const run: Run = { summary: { ...input, id, status: 'starting', createdAt: new Date().toISOString() }, events: [], controller: new AbortController(), finished: Promise.resolve() };
    this.runs.set(id, run);
    this.active = id;
    this.emit(run, 'run.started', run.summary);
    run.finished = this.execute(run);
    return run.summary;
  }
  stop(id: string): void {
    const run = this.get(id);
    if (this.active !== id || run.controller.signal.aborted) return;
    run.summary.status = 'stopping';
    this.emit(run, 'run.stopping', { message: 'Stopping at the next action boundary; in-flight input cannot be undone.' });
    run.controller.abort(new Error('Stopped by user'));
  }
  async close(): Promise<void> {
    if (this.active) this.stop(this.active);
    await Promise.all([...this.runs.values()].map(run => run.finished));
  }
  private emit(run: Run, type: string, data: unknown, attempt?: number): void {
    const event: RunEvent = JSON.parse(JSON.stringify({ id: run.events.length + 1, time: new Date().toISOString(), type, ...(attempt === undefined ? {} : { attempt }), data }));
    run.events.push(event);
    try { appendFileSync(join(this.traceDir, `${run.summary.id}.jsonl`), JSON.stringify(event) + '\n', { mode: 0o600 }); }
    catch { run.summary.traceError = 'Could not persist trace; the in-memory trace remains downloadable.'; }
    this.updates.emit(run.summary.id, event);
  }
  private async execute(run: Run): Promise<void> {
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    let fixture: Awaited<ReturnType<typeof serveFixture>> | undefined;
    let terminal: { status: string; verified?: boolean; steps?: number; url?: string; message?: string } = { status: 'error' };
    let attempt = 0;
    const onEvent: ProgressSink = event => {
      if (event.attempt !== undefined) attempt = event.attempt;
      this.emit(run, event.type, event.data, attempt);
    };
    try {
      const { demo, goal, maxSteps } = run.summary;
      if (demo) { fixture = await serveFixture(); run.summary.url = fixture.url; }
      run.controller.signal.throwIfAborted();
      browser = await openBrowser({
        ...(this.env.CDP_ENDPOINT ? { endpoint: this.env.CDP_ENDPOINT } : {}),
        ...(this.env.CHROME_PATH ? { executable: this.env.CHROME_PATH } : {}),
        headless: this.env.HEADLESS !== 'false',
      });
      run.controller.signal.throwIfAborted();
      this.emit(run, 'browser.ready', { url: run.summary.url, transport: 'CDP' });
      await browser.cdp.navigate(run.summary.url);
      run.summary.status = 'running';
      const decisions = demo ? demoProvider(onEvent) : new JevProvider({
        apiKey: this.env.TYPESAFE_API_KEY!, model: this.env.TYPESAFE_MODEL ?? 'jev-latest',
        url: this.env.TYPESAFE_URL ?? 'https://api.typesafe.ai/v1/systemone', onEvent,
      });
      const text = demo ? { fill: async () => 'Ada' } : new TextModelProvider({
        apiKey: this.env.TEXT_MODEL_API_KEY!, model: this.env.TEXT_MODEL!, baseUrl: this.env.TEXT_MODEL_BASE_URL ?? 'https://openrouter.ai/api/v1',
      });
      const result: RunResult = await runAgent(goal, {
        browser: browser.cdp, decisions, text, maxSteps, signal: run.controller.signal, onEvent,
        ...(demo ? { verify: (snapshot: RunResult['snapshot']) => snapshot.text.includes('Submitted: Ada / demo') } : {}),
      });
      terminal = { status: result.status, verified: result.verified, steps: result.steps.length, url: result.snapshot.url };
    } catch (error) {
      terminal = { status: run.controller.signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message : 'Run failed' };
    } finally {
      try { await Promise.all([browser?.close(), fixture?.close()]); }
      catch (error) { terminal = { status: 'error', message: `Cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}` }; }
      run.summary.status = terminal.status;
      this.active = undefined;
      this.emit(run, 'run.finished', { ...terminal, ...(run.summary.traceError ? { traceError: run.summary.traceError } : {}) });
    }
  }
}

/** Explicitly synthetic scores for the API-free fixture; never presented as Jev output. */
function demoProvider(onEvent: ProgressSink): DecisionProvider {
  return { async decide(context) {
    const { snapshot } = context;
    const name = snapshot.targets.find(t => t.label === 'Name');
    const topic = snapshot.targets.find(t => t.label === 'Topic');
    let decision: Decision;
    if (snapshot.text.includes('Submitted: Ada / demo')) decision = { operation: 'DONE', confidence: 1 };
    else if (name && name.value !== 'Ada') decision = { operation: 'TYPE_TEXT', target: name.id, confidence: 1 };
    else if (topic && topic.value !== 'demo') decision = { operation: 'SELECT', target: topic.options.find(o => o.value === 'demo')!.id, confidence: 1 };
    else decision = { operation: 'CLICK', target: snapshot.targets.find(t => t.label === 'Send')!.id, confidence: 1 };
    const { questions } = buildActionSpace(context);
    onEvent({ type: 'decision.request', data: { questions, model: 'fixture (synthetic scores)' } });
    const answers: Record<string, unknown> = {};
    for (const [head, question] of Object.entries(questions)) {
      const choices = Object.keys((question as { criteria: object }).criteria);
      const choice = head === 'operation' ? decision.operation : head === `${decision.operation.toLowerCase()}_target` ? decision.target! : choices[0]!;
      answers[head] = { choice, confidence: 1, probabilities: Object.fromEntries(choices.map(id => [id, Number(id === choice)])) };
    }
    onEvent({ type: 'decision.response', data: { answers, model: 'fixture (synthetic scores)', latencyMs: 0, usage: null, selectedHead: `${decision.operation.toLowerCase()}_target` } });
    return decision;
  } };
}
