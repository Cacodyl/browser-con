import { buildActionSpace } from './action-space.js';
import type { DecisionContext, DecisionProvider, Operation, ProgressSink } from '../types.js';
import { postJSON, record } from './http.js';

export function validateChoice(value: unknown, choices: string[]): { choice: string; confidence: number } {
  const answer = record(value);
  const probabilities = record(answer.probabilities);
  const validNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const values = Object.values(probabilities);
  if (typeof answer.choice !== 'string' || !choices.includes(answer.choice) ||
      !validNumber(answer.confidence) || Object.keys(probabilities).length !== choices.length ||
      !choices.every(id => validNumber(probabilities[id])) || !values.every(validNumber)) {
    throw new Error('Invalid Jev choice');
  }
  const numbers = values as number[];
  if (Math.abs(numbers.reduce((a, b) => a + b, 0) - 1) > 0.02 ||
      (probabilities[answer.choice] as number) + 1e-6 < Math.max(...numbers)) throw new Error('Invalid Jev distribution');
  return { choice: answer.choice, confidence: answer.confidence };
}
export class JevProvider implements DecisionProvider {
  constructor(private config: { apiKey: string; model?: string; url?: string; onEvent?: ProgressSink }) {
    if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is required');
  }
  async decide(context: DecisionContext) {
    const { operations, groups, questions } = buildActionSpace(context);
    this.config.onEvent?.({ type: 'decision.request', data: { questions, model: this.config.model ?? 'jev-latest' } });
    const started = performance.now();
    const result = record(await postJSON(this.config.url ?? 'https://api.typesafe.ai/v1/systemone', this.config.apiKey, {
      model: this.config.model ?? 'jev-latest', state: { page: context.snapshot, recent_actions: context.history.slice(-8) }, questions,
    }, context.signal));
    const answers = record(result.answers);
    const selected = validateChoice(answers.operation, Object.keys(operations));
    const operation = selected.choice as Operation;
    const candidates = groups[operation];
    const report = () => this.config.onEvent?.({ type: 'decision.response', data: {
      answers, model: result.model ?? this.config.model ?? 'jev-latest', usage: result.usage ?? null,
      latencyMs: performance.now() - started, selectedHead: `${operation.toLowerCase()}_target`,
    } });
    if (candidates && Object.keys(candidates).length) {
      const target = validateChoice(answers[`${operation.toLowerCase()}_target`], Object.keys(candidates));
      report();
      return { operation, target: target.choice, confidence: Math.min(selected.confidence, target.confidence) };
    }
    report();
    return { operation, confidence: selected.confidence };
  }
}
