// AI feature: the solver picks a real sub-step of a real solution; the LLM turns it into a coach-style nudge.
// The rephrase is only used if it still contains the solver's exact sub-step and does not leak the full answer,
// so the LLM can change the wording but never the math. Otherwise the plain solver hint is sent.
import { HINT_TIMEOUT_MS } from './config.js';
import { llmEnabled, chatJSON } from './llm.js';
import { hintSteps, treeToString } from '../shared/solver.js';

const SYSTEM = `You are a friendly, upbeat coach in IQ180, a 60-second math race: players must reach a target
number using all five given digits once each, with + - x / and parentheses.
You are given one verified FACT: a step of a working solution (never mention that wording). Rewrite it as a single encouraging hint
(max 25 words). Rules:
- Keep the FACT's expression and number exactly as written (same digits, same operators, "x" for multiply).
- Add no other math: no other numbers, operations or guesses about the next move (not even "double it").
- Never write the complete solution.
- No preamble, no emojis.
Reply with JSON only: {"hint":"<your hint>"}`;

const norm = (s) => String(s).toLowerCase().replace(/[×*∗]/g, 'x').replace(/[÷]/g, '/').replace(/\s+/g, '');

// Pure check, exported for tests: does the LLM text keep the fact and avoid leaking the answer?
export function isSafeHint(text, step, fullSolution) {
  if (typeof text !== 'string' || !text.trim() || text.length > 220) return false;
  const t = norm(text);
  if (t.includes(norm(fullSolution))) return false;
  if (step.expr) return t.includes(norm(step.expr)) && t.includes(norm(step.value));
  return t.includes(norm(step.op));
}

// Returns { text, source: 'ai' | 'solver' } for hint number `index` (0-based) of this solution tree.
export async function makeHint({ tree, index, digits, target }) {
  const steps = hintSteps(tree);
  const step = steps[Math.min(index, steps.length - 1)];
  if (llmEnabled) {
    try {
      const fact = step.expr ? `${step.expr} = ${step.value}` : `the final operation of a solution is "${step.op}"`;
      const reply = await chatJSON({
        system: SYSTEM,
        user: `Digits: ${digits.join(', ')}\nTarget: ${target}\nHint number: ${index + 1}\nFACT: ${fact}`,
        timeoutMs: HINT_TIMEOUT_MS,
        maxTokens: 1000,
        temperature: 0.7,
      });
      const text = reply?.hint?.trim();
      if (isSafeHint(text, step, treeToString(tree))) return { text, source: 'ai' };
      console.warn(`[hint] LLM hint rejected, using solver hint: ${JSON.stringify(text)}`);
    } catch (err) {
      console.warn(`[hint] LLM call failed, using solver hint: ${err?.message ?? err}`);
    }
  }
  return { text: step.text, source: 'solver' };
}
