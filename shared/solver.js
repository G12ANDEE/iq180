// Exhaustive solver: combines the five digits pairwise with + - x / until one value remains.
// Every expression shape over all five digits is reached, so any target it misses is unsolvable.
import { Fraction } from './fraction.js';

const PREC = { '+': 1, '-': 1, 'x': 2, '/': 2 };

const leaf = (digit, slot) => ({ v: new Fraction(digit), slot, digit });
const node = (op, l, r, v) => ({ v, op, l, r });

function combine(a, b) {
  const out = [node('+', a, b, a.v.add(b.v)), node('x', a, b, a.v.mul(b.v)),
    node('-', a, b, a.v.sub(b.v)), node('-', b, a, b.v.sub(a.v))];
  if (b.v.num !== 0) out.push(node('/', a, b, a.v.div(b.v)));
  if (a.v.num !== 0) out.push(node('/', b, a, b.v.div(a.v)));
  return out;
}

// Returns Map<integer target, tree[]> keeping up to `keep` distinct-looking solutions per target.
export function solveAll(digits, { keep = 4 } = {}) {
  const results = new Map();
  const seenStr = new Map();
  function rec(items) {
    if (items.length === 1) {
      const t = items[0];
      if (!t.v.isInteger()) return;
      const n = t.v.num;
      let list = results.get(n);
      if (!list) { list = []; results.set(n, list); seenStr.set(n, new Set()); }
      if (list.length >= keep) return;
      const s = canonical(t);
      if (seenStr.get(n).has(s)) return;
      seenStr.get(n).add(s);
      list.push(t);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const rest = items.filter((_, k) => k !== i && k !== j);
        for (const c of combine(items[i], items[j])) rec([...rest, c]);
      }
    }
  }
  rec(digits.map((d, i) => leaf(d, i)));
  return results;
}

// Flattens + / x chains and sorts operands so 1+2+3 and 3+(2+1) count as the same solution.
function canonical(t) {
  if (t.slot !== undefined) return String(t.digit);
  const group = t.op === '+' || t.op === '-' ? 'add' : 'mul';
  const pos = [], neg = [];
  (function gather(n, sign) {
    const g = n.slot === undefined && (n.op === '+' || n.op === '-' ? 'add' : 'mul');
    if (g !== group) { (sign ? pos : neg).push(canonical(n)); return; }
    gather(n.l, sign);
    gather(n.r, (n.op === '-' || n.op === '/') ? !sign : sign);
  })(t, true);
  const [a, b] = group === 'add' ? ['+', '-'] : ['x', '/'];
  return `[${pos.sort().join(a)}${b}${neg.sort().join(b)}]`;
}

export function treeToString(t) {
  if (t.slot !== undefined) return String(t.digit);
  const p = PREC[t.op];
  const wrap = (child, right) => {
    const s = treeToString(child);
    if (child.slot !== undefined) return s;
    const cp = PREC[child.op];
    const needs = cp < p || (right && cp === p && (t.op === '-' || t.op === '/'));
    return needs ? `(${s})` : s;
  };
  return `${wrap(t.l, false)} ${t.op} ${wrap(t.r, true)}`;
}

// Token array (same shape the client submits), always fully parenthesized for safety.
export function treeToTokens(t) {
  if (t.slot !== undefined) return [{ t: 'digit', i: t.slot }];
  return [{ t: 'lp' }, ...treeToTokens(t.l), { t: 'op', v: t.op }, ...treeToTokens(t.r), { t: 'rp' }];
}

const leafCount = (t) => (t.slot !== undefined ? 1 : leafCount(t.l) + leafCount(t.r));

// Progressive hints: smallest sub-step first, then a bigger chunk, never the full answer.
export function hintsFor(tree) {
  const inner = [];
  (function walk(t, isRoot) {
    if (t.slot !== undefined) return;
    if (!isRoot) inner.push(t);
    walk(t.l, false); walk(t.r, false);
  })(tree, true);
  inner.sort((a, b) => leafCount(a) - leafCount(b));
  const hints = [];
  if (inner.length) {
    const first = inner[0];
    hints.push(`Try making ${first.v} with ${treeToString(first)}`);
    const big = inner[inner.length - 1];
    if (big !== first) hints.push(`Build ${treeToString(big)} = ${big.v}, then finish with one more step`);
    else hints.push(`The last step uses "${tree.op}"`);
  } else {
    hints.push(`The last step uses "${tree.op}"`);
  }
  return hints;
}
