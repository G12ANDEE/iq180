// AI feature: the opponent's "brain". Asks a free LLM (Groq by default, any OpenAI-compatible
// endpoint via BOT_BASE_URL) to solve the puzzle, then validates the answer with our own judge.
// If the key is missing or the model is wrong, the caller falls back to the exhaustive solver,
// so the bot is never broken — the LLM only decides *how* it plays, never whether it can.
import { judge } from '../shared/expr.js';
import { BOT_BASE_URL, BOT_MODEL, BOT_API_KEY, BOT_TIMEOUT_MS } from './config.js';

const SYSTEM = `You are a contestant in IQ180, a mental-math game. You get five single digits and a
target number. Combine ALL FIVE digits, each used exactly once, with + - * / and parentheses so the
expression equals the target. No concatenation: you may not join 3 and 4 into 34. Exact arithmetic,
so 7/2*2 = 7 is fine. Reply with ONLY the arithmetic expression — no words, no explanation.`;

export function hasBot() { return Boolean(BOT_API_KEY); }

// Reasoning models (e.g. Qwen3) answer with a long worked solution in LaTeX rather than a bare
// expression. Normalise the maths notation and return every expression-looking candidate, newest
// first — the caller keeps the first one that actually verifies, so a correct final answer is found
// even when it is buried in rambly reasoning full of discarded attempts.
function candidateExpressions(text) {
  const cleaned = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')          // drop reasoning if it leaks into content
    .replace(/```[a-z]*/gi, '').replace(/`/g, '')
    .replace(/\\times|\\cdot/gi, '*').replace(/\\div/gi, '/')  // LaTeX operators
    .replace(/\\left|\\right|\\!|\\,|\\;/gi, '').replace(/[$]/g, '');
  const matches = cleaned.match(/[0-9+\-*/×÷xX()[\]\s]*[0-9][0-9+\-*/×÷xX()[\]\s]*/g) ?? [];
  return matches.map((m) => m.trim()).reverse();
}

// Turn a plain value expression (e.g. "(3+4)*2") into the game's token array, mapping each digit
// to an unused slot of the same value. Returns null if it uses an unavailable value, concatenates
// digits, or contains anything unexpected.
export function expressionToTokens(expr, digits) {
  const slots = digits.map((d, i) => ({ d, i, used: false }));
  const take = (value) => {
    const s = slots.find((x) => !x.used && x.d === value);
    if (!s) return null;
    s.used = true;
    return s.i;
  };
  const tokens = [];
  const chars = [...String(expr)];
  for (let k = 0; k < chars.length; k++) {
    const c = chars[k];
    if (/\s/.test(c)) continue;
    if (/[0-9]/.test(c)) {
      let num = c;
      while (k + 1 < chars.length && /[0-9]/.test(chars[k + 1])) num += chars[++k];
      if (num.length !== 1) return null;            // no concatenation allowed
      const i = take(Number(num));
      if (i === null) return null;                   // value not among the dealt digits
      tokens.push({ t: 'digit', i });
    } else if (c === '+' || c === '-') tokens.push({ t: 'op', v: c });
    else if ('*xX×·'.includes(c)) tokens.push({ t: 'op', v: 'x' });
    else if (c === '/' || c === '÷' || c === ':') tokens.push({ t: 'op', v: '/' });
    else if (c === '(' || c === '[') tokens.push({ t: 'lp' });
    else if (c === ')' || c === ']') tokens.push({ t: 'rp' });
    else if (c === '=') break;                        // ignore a trailing "= target"
    else return null;                                 // unexpected character
  }
  return tokens.length ? tokens : null;
}

// Returns { expression, tokens } if the LLM produced a verified-correct answer, else null.
export async function aiSolve(digits, target) {
  if (!BOT_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BOT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BOT_API_KEY}` },
      body: JSON.stringify({
        model: BOT_MODEL,
        temperature: 0.2,
        max_tokens: 2048,                 // reasoning models need room to think before answering
        reasoning_format: 'hidden',       // Groq: return only the final answer in content (ignored elsewhere)
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Digits: ${digits.join(', ')}. Target: ${target}. Give one expression using all five digits that equals ${target}.` },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) { console.warn(`[bot] LLM responded ${res.status}`); return null; }
    const data = await res.json();
    for (const expr of candidateExpressions(data.choices?.[0]?.message?.content ?? '')) {
      const tokens = expressionToTokens(expr, digits);
      if (tokens && judge(tokens, digits, target).ok) return { expression: expr, tokens };
    }
    return null;
  } catch (err) {
    console.warn(`[bot] LLM solve failed: ${err?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
