import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../shared/expr.js';
import { generatePuzzle } from '../server/generator.js';
import { hintsFor } from '../shared/solver.js';

test('100 generated puzzles are solvable and every key solution verifies with the real judge', () => {
  for (let n = 0; n < 100; n++) {
    const p = generatePuzzle();
    assert.equal(p.digits.length, 5);
    assert.ok(p.digits.every((d) => Number.isInteger(d) && d >= 0 && d <= 9));
    assert.ok(Number.isInteger(p.target) && p.target >= 1 && p.target <= 99);
    for (const tree of p.solutions) assert.ok(tree.v.isInteger() && tree.v.num === p.target);
    const verdict = judge(p.keyTokens, p.digits, p.target);
    assert.ok(verdict.ok, `${p.keySolution} should equal ${p.target}: ${verdict.reason}`);
    const hints = hintsFor(p.solutions[0]);
    assert.ok(hints.length >= 1 && hints.length <= 2);
  }
});

test('AI hint guard keeps the solver fact and blocks full-answer leaks', async () => {
  const { isSafeHint } = await import('../server/hint.js');
  const step = { expr: '3 x 7', value: '21' };
  assert.ok(isSafeHint('Nice start! Try 3 × 7 = 21 and see where that takes you.', step, '3 x 7 + 2'));
  assert.ok(!isSafeHint('Try 3 + 7 = 10 first.', step, '3 x 7 + 2'), 'changed math is rejected');
  assert.ok(!isSafeHint('Just do 3 x 7 = 21, then 3 x 7 + 2.', step, '3 x 7 + 2'), 'full answer is rejected');
  assert.ok(isSafeHint('Save the "-" for your very last move.', { op: '-' }, '9 x 2 - 1'));
  assert.ok(!isSafeHint('', step, '3 x 7 + 2'));
});
