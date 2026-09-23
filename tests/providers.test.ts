import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChoice } from '../src/providers/jev.js';
import { parseFieldText } from '../src/providers/text.js';

test('Jev rejects unknown targets, invalid distributions, and non-maximal choices', () => {
  assert.equal(validateChoice({ choice: '1', confidence: 0.9, probabilities: { '1': 0.8, '2': 0.2 } }, ['1', '2']).choice, '1');
  for (const answer of [
    { choice: '3', confidence: 1, probabilities: { '1': 1 } },
    { choice: '1', confidence: NaN, probabilities: { '1': 1 } },
    { choice: '1', confidence: 1, probabilities: { '1': 0.1, '2': 0.9 } },
    { choice: '1', confidence: 1, probabilities: { '1': 0.6, '2': 0.6 } },
  ]) assert.throws(() => validateChoice(answer, ['1', '2']));
});
test('Text model accepts exact JSON and rejects missing/extra fields', () => {
  assert.equal(parseFieldText('{"text":"Ada"}'), 'Ada');
  for (const value of ['plain text', '{"error":"missing information"}', '{"text":"Ada","script":"x"}', JSON.stringify({ text: 'x'.repeat(2001) })]) assert.throws(() => parseFieldText(value));
});
