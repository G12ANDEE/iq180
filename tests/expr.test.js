import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, evaluate, tokensToString } from '../shared/expr.js';

const D = (i) => ({ t: 'digit', i });
const O = (v) => ({ t: 'op', v });
const LP = { t: 'lp' }, RP = { t: 'rp' };

test('exact arithmetic: 7 / 2 x 2 = 7', () => {
  const digits = [7, 2, 2, 0, 0];
  assert.equal(evaluate([D(0), O('/'), D(1), O('x'), D(2)], digits).toString(), '7');
});

test('precedence and parentheses', () => {
  const digits = [2, 3, 4, 1, 1];
  assert.equal(evaluate([D(0), O('+'), D(1), O('x'), D(2)], digits).toString(), '14');
  assert.equal(evaluate([LP, D(0), O('+'), D(1), RP, O('x'), D(2)], digits).toString(), '20');
});

test('judge accepts a correct all-digit answer', () => {
  const digits = [1, 2, 3, 4, 5];
  const toks = [D(0), O('+'), D(1), O('+'), D(2), O('+'), D(3), O('+'), D(4)];
  assert.deepEqual(judge(toks, digits, 15).ok, true);
  assert.equal(tokensToString(toks, digits), '1 + 2 + 3 + 4 + 5');
});

test('judge rejects digit reuse, missing digits, wrong value, /0, concatenation, junk', () => {
  const digits = [1, 2, 3, 4, 0];
  const all = (op) => [D(0), O(op), D(1), O(op), D(2), O(op), D(3), O(op), D(4)];
  assert.match(judge([D(0), O('+'), D(0)], digits, 2).reason, /only once/);
  assert.match(judge([D(0), O('+'), D(1)], digits, 3).reason, /all 5/);
  assert.match(judge(all('+'), digits, 99).reason, /not 99/);
  assert.match(judge(all('/'), digits, 1).reason, /Division by zero/);
  assert.match(judge([D(0), D(1), O('+'), D(2), O('+'), D(3), O('+'), D(4)], digits, 1).reason, /concatenation/);
  assert.match(judge([{ t: 'eval', v: 'process.exit()' }], digits, 1).reason, /Malformed/);
  assert.match(judge('1+2', digits, 3).reason, /Empty/);
  assert.match(judge([D(0), O('+'), LP, D(1), O('+'), D(2), O('+'), D(3), O('+'), D(4)], digits, 10).reason, /Missing \)/);
});
