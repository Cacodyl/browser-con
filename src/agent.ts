import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { CDP } from './browser/cdp.js';
import { getDOMSnapshot, StaleSnapshotError } from './browser/snapshot.js';
import { execute } from './browser/execute.js';
import type { DecisionProvider, TextProvider, Step, Snapshot, RunResult, ProgressSink } from './types.js';

export interface AgentOptions {
  browser: CDP;
  decisions: DecisionProvider;
  text: TextProvider;
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: ProgressSink;
  onStep?: (step: Step) => void;
  verify?: (snapshot: Snapshot) => boolean | Promise<boolean>;
}
export async function runAgent(goal: string, options: AgentOptions): Promise<RunResult> {
  if (!goal.trim()) throw new Error('A non-empty goal is required');
  const maxSteps = options.maxSteps ?? 30;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) throw new Error('maxSteps must be an integer from 1 to 1000');
  const steps: Step[] = [];
  let noProgress = 0;
  let last: Snapshot | undefined;
  for (let attempt = 0; attempt < maxSteps; attempt++) {
    options.signal?.throwIfAborted();
    const emit: ProgressSink = event => options.onEvent?.({ ...event, attempt: attempt + 1 });
    const started = performance.now();
    const observed = await getDOMSnapshot(options.browser);
    last = observed.snapshot;
    const snapshotMs = performance.now() - started;
    try {
      emit({ type: 'snapshot', data: observed.snapshot });
      const context = { goal, snapshot: observed.snapshot, history: steps, ...(options.signal ? { signal: options.signal } : {}) };
      const decisionStart = performance.now();
      const decision = await options.decisions.decide(context);
      options.signal?.throwIfAborted();
      emit({ type: 'decision', data: decision });
      const decisionMs = performance.now() - decisionStart;
      let text: string | undefined;
      const textStart = performance.now();
      if (decision.operation === 'TYPE_TEXT') {
        const target = observed.snapshot.targets.find(t => t.id === decision.target);
        if (!target || !target.operations.includes('TYPE_TEXT')) throw new Error('Invalid fill target');
        emit({ type: 'text.request', data: { target: target.id, label: target.label } });
        text = await options.text.fill({ ...context, target });
      }
      if (text !== undefined) emit({ type: 'text.ready', data: { characters: text.length, value: '[redacted]' } });
      options.signal?.throwIfAborted();
      const textMs = performance.now() - textStart;
      const actionStart = performance.now();
      emit({ type: 'action.started', data: decision });
      await execute(options.browser, observed, decision, text, options.signal);
      emit({ type: 'action.executed', data: { ...decision, latencyMs: performance.now() - actionStart } });
      // Log execution before taking another observation; never automatically retry input errors.
      const step: Step = { index: steps.length + 1, decision, url: last.url, changed: false, timing: { snapshotMs, decisionMs, textMs, actionMs: performance.now() - actionStart } };
      steps.push(step);
      if (decision.operation === 'DONE' || decision.operation === 'BLOCKED') {
        emit({ type: 'step', data: step });
        options.onStep?.(step);
        return { status: decision.operation === 'DONE' ? 'done' : 'blocked', verified: decision.operation === 'DONE' && !!options.verify && await options.verify(last), snapshot: last, steps };
      }
      await delay(75, undefined, { signal: options.signal });
      const after = await getDOMSnapshot(options.browser);
      try {
        last = after.snapshot;
        step.changed = JSON.stringify(observed.snapshot) !== JSON.stringify(last);
      } finally { await after.dispose(); }
      emit({ type: 'step', data: step });
      options.onStep?.(step);
      noProgress = step.changed ? 0 : noProgress + 1;
      if (noProgress >= 5) return { status: 'stalled', verified: false, snapshot: last, steps };
    } catch (error) {
      if (!(error instanceof StaleSnapshotError)) throw error;
      emit({ type: 'stale', data: { message: error.message } });
      // Stale decisions consume budget too; only pre-action stale failures are retried.
    } finally { await observed.dispose(); }
  }
  return { status: 'budget_exhausted', verified: false, snapshot: last!, steps };
}
