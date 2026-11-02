// Tokenizer-free parser: the client submits a structured token array, never a string to eval.
// Token shapes: { t: 'digit', i: <slot 0-4> } | { t: 'op', v: '+'|'-'|'x'|'/' } | { t: 'lp' } | { t: 'rp' }
import { Fraction } from './fraction.js';

export const OPS = ['+', '-', 'x', '/'];

export class ExprError extends Error {}

const apply = (op, a, b) => {
  switch (op) {
    case '+': return a.add(b);
    case '-': return a.sub(b);
    case 'x': return a.mul(b);
    case '/':
      if (b.num === 0) throw new ExprError('Division by zero');
      return a.div(b);
  }
  throw new ExprError(`Unknown operator ${op}`);
};

// Validate token shapes and digit-slot usage. Returns null if OK, else a reason string.
export function checkTokens(tokens, digits, { requireAll = true } = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return 'Empty expression';
  if (tokens.length > 64) return 'Expression too long';
  const used = new Set();
  for (const tok of tokens) {
    if (!tok || typeof tok !== 'object') return 'Malformed token';
    if (tok.t === 'digit') {
      if (!Number.isInteger(tok.i) || tok.i < 0 || tok.i >= digits.length) return 'Unknown digit';
      if (used.has(tok.i)) return 'Each digit can be used only once';
      used.add(tok.i);
    } else if (tok.t === 'op') {
      if (!OPS.includes(tok.v)) return 'Unknown operator';
    } else if (tok.t !== 'lp' && tok.t !== 'rp') {
      return 'Malformed token';
    }
  }
  if (requireAll && used.size !== digits.length) return `Use all ${digits.length} digits`;
  return null;
}

// Recursive descent: expr := term (('+'|'-') term)* ; term := factor (('x'|'/') factor)* ;
// factor := digit | '(' expr ')'. Adjacent digits are a syntax error (no concatenation).
export function evaluate(tokens, digits) {
  let pos = 0;
  const peek = () => tokens[pos];

  function parseExpr() {
    let left = parseTerm();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = tokens[pos++].v;
      left = apply(op, left, parseTerm());
    }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    while (peek()?.t === 'op' && (peek().v === 'x' || peek().v === '/')) {
      const op = tokens[pos++].v;
      left = apply(op, left, parseFactor());
    }
    return left;
  }
  function parseFactor() {
    const tok = tokens[pos++];
    if (!tok) throw new ExprError('Expression is incomplete');
    if (tok.t === 'digit') return new Fraction(digits[tok.i]);
    if (tok.t === 'lp') {
      const v = parseExpr();
      if (tokens[pos++]?.t !== 'rp') throw new ExprError('Missing )');
      return v;
    }
    throw new ExprError('Unexpected ' + (tok.t === 'rp' ? ')' : tok.v));
  }

  const value = parseExpr();
  if (pos !== tokens.length) throw new ExprError('Unexpected ' + describe(tokens[pos]));
  return value;
}

const describe = (tok) => tok.t === 'digit' ? 'digit (no concatenation)' : tok.t === 'op' ? tok.v : tok.t === 'lp' ? '(' : ')';

// Parse a token array into an AST (recording each operation's exact value) and return an ordered,
// human-readable arithmetic trace, innermost step first: e.g. ["3 + 4 = 7", "7 × 2 = 14"].
// Used to show how the AI opponent's answer is built, step by step. Assumes valid tokens.
const STEP_SYM = { '+': '+', '-': '−', 'x': '×', '/': '÷' };
export function stepsFromTokens(tokens, digits) {
  let pos = 0;
  const peek = () => tokens[pos];
  const mk = (v, op, l, r) => ({ v, op, l, r });
  function parseExpr() {
    let left = parseTerm();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = tokens[pos++].v, right = parseTerm();
      left = mk(apply(op, left.v, right.v), op, left, right);
    }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    while (peek()?.t === 'op' && (peek().v === 'x' || peek().v === '/')) {
      const op = tokens[pos++].v, right = parseFactor();
      left = mk(apply(op, left.v, right.v), op, left, right);
    }
    return left;
  }
  function parseFactor() {
    const tok = tokens[pos++];
    if (!tok) throw new ExprError('Expression is incomplete');
    if (tok.t === 'digit') return mk(new Fraction(digits[tok.i]));
    if (tok.t === 'lp') {
      const v = parseExpr();
      if (tokens[pos++]?.t !== 'rp') throw new ExprError('Missing )');
      return v;
    }
    throw new ExprError('Unexpected token');
  }
  const root = parseExpr();
  const steps = [];
  (function walk(n) {
    if (!n.op) return;
    walk(n.l); walk(n.r);
    steps.push(`${n.l.v} ${STEP_SYM[n.op]} ${n.r.v} = ${n.v}`);
  })(root);
  return steps;
}

export function tokensToString(tokens, digits) {
  return tokens.map((t) => t.t === 'digit' ? String(digits[t.i]) : t.t === 'op' ? t.v : t.t === 'lp' ? '(' : ')').join(' ')
    .replace(/\( /g, '(').replace(/ \)/g, ')');
}

// Full server-side check of a submission. Returns { ok, reason?, value? }.
export function judge(tokens, digits, target) {
  const bad = checkTokens(tokens, digits);
  if (bad) return { ok: false, reason: bad };
  let value;
  try { value = evaluate(tokens, digits); } catch (e) {
    if (e instanceof ExprError || /Division by zero/.test(e.message)) return { ok: false, reason: e.message };
    throw e;
  }
  if (!value.isInteger() || value.num !== target) return { ok: false, reason: `That makes ${value}, not ${target}`, value: value.toString() };
  return { ok: true, value: value.toString() };
}
