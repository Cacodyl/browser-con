import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionSpace } from '../src/providers/action-space.js';
import { parseRunInput } from '../src/server/runs.js';
import { JevProvider } from '../src/providers/jev.js';
import type { DecisionContext, ProgressEvent } from '../src/types.js';

const context: DecisionContext = { goal: 'Pick demo', history: [], snapshot: {
  url: 'https://example.com', title: 'Form', text: 'Form', scrollY: 0, canScrollDown: false,
  targets: [
    { id: '1', label: 'Name', role: 'text', value: '', checked: null, operations: ['TYPE_TEXT', 'ENTER', 'CLICK'], options: [] },
    { id: '2', label: 'Topic', role: 'select', value: 'support', checked: null, operations: ['SELECT'], options: [{ id: '2:1', label: 'Demo', value: 'demo' }] },
  ],
} };
test('decision space partitions compatible targets and observed dropdown options', () => {
  const space = buildActionSpace(context);
  assert.deepEqual(Object.keys(space.groups.TYPE_TEXT!), ['1']);
  assert.deepEqual(Object.keys(space.groups.SELECT!), ['2:1']);
  assert.equal(space.operations.SCROLL_UP, undefined);
  assert.equal(space.operations.SCROLL_DOWN, undefined);
  assert.ok(space.questions.operation);
  const empty = buildActionSpace({ ...context, snapshot: { ...context.snapshot, targets: [] } });
  assert.deepEqual(Object.keys(empty.operations).sort(), ['BLOCKED', 'DONE', 'WAIT']);
});
test('run validation rejects unsupported URLs and unbounded budgets', () => {
  assert.equal(parseRunInput({ url: 'https://example.com', goal: 'Go', maxSteps: 5 }).maxSteps, 5);
  for (const input of [
    { url: 'file:///etc/passwd', goal: 'Go' }, { url: 'https://user:pass@example.com', goal: 'Go' },
    { url: 'https://example.com', goal: '' }, { url: 'https://example.com', goal: 'Go', maxSteps: 51 }, { demo: 'true' },
  ]) assert.throws(() => parseRunInput(input));
});
test('Jev logs question heads and scores, validating only the selected target head', async t => {
  const progress: ProgressEvent[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.ok(request.questions.select_target.criteria['2:1']);
    return new Response(JSON.stringify({ model: 'test-jev', usage: { input_tokens: 10 }, answers: {
      operation: { choice: 'SELECT', confidence: 0.9, probabilities: Object.fromEntries(Object.keys(request.questions.operation.criteria).map(key => [key, Number(key === 'SELECT')])) },
      select_target: { choice: '2:1', confidence: 0.8, probabilities: { '2:1': 1 } },
      click_target: { invalidUnusedHead: true },
    } }), { status: 200 });
  });
  const decision = await new JevProvider({ apiKey: 'test-secret', onEvent: event => progress.push(event) }).decide(context);
  assert.equal(decision.target, '2:1');
  assert.equal(decision.confidence, 0.8);
  assert.deepEqual(progress.map(event => event.type), ['decision.request', 'decision.response']);
  assert.ok(JSON.stringify(progress).includes('probabilities'));
  assert.ok(!JSON.stringify(progress).includes('test-secret'));
});
