// AI feature: a tongue-in-cheek "IQ" for each player, written by an LLM from their match stats.
// Falls back to a local formula when there is no API key, the call fails, or it takes too long.
import { IQ_TIMEOUT_MS } from './config.js';
import { llmEnabled, chatJSON } from './llm.js';

const SYSTEM = `You are the sarcastic-but-kind announcer of IQ180, a party math game where players race to
reach a target number using five digits with + - x / and parentheses within 60 seconds.
Given each player's match stats, invent a playful "IQ" (an integer from 0 to 180) and a one-sentence roast
(max 20 words). Faster correct solves, fewer wrong attempts and fewer hints deserve higher IQs.
Keep it light, never mean about anything except their arithmetic. Everyone knows the number is a joke.
Reply with JSON only, exactly this shape, one entry per player, names copied exactly:
{"players":[{"name":"<player name>","iq":<integer>,"roast":"<one sentence>"}]}`;

// stats: [{ name, won, timedOut, attempts, wrongAttempts, hintsUsed, secondsToSolve|null, target, digits }]
export async function iqReport(stats) {
  if (llmEnabled) {
    try {
      const reports = await askLLM(stats);
      if (reports) return { source: 'ai', reports };
    } catch (err) {
      console.warn(`[iq] LLM call failed, using fallback: ${err?.message ?? err}`);
    }
  }
  return { source: 'formula', reports: stats.map(fallback) };
}

async function askLLM(stats) {
  const reply = await chatJSON({ system: SYSTEM, user: `Match stats:\n${JSON.stringify(stats, null, 2)}`, timeoutMs: IQ_TIMEOUT_MS });
  const players = reply?.players;
  if (!Array.isArray(players)) return null;
  // Re-key by the names we sent so a model typo can't drop or swap a player.
  return stats.map((s, i) => {
    const r = players.find((p) => p?.name === s.name) ?? players[i];
    const iq = Number(r?.iq);
    if (!r || !Number.isFinite(iq) || typeof r.roast !== 'string') return fallback(s);
    return { name: s.name, iq: Math.max(0, Math.min(180, Math.round(iq))), roast: r.roast.slice(0, 200) };
  });
}

function fallback(s) {
  let iq = 100;
  if (s.won) iq += 25 + Math.max(0, 60 - (s.secondsToSolve ?? 60)) * 0.6;
  else if (s.timedOut) iq -= 5;
  iq -= s.wrongAttempts * 4 + s.hintsUsed * 8;
  iq = Math.max(0, Math.min(180, Math.round(iq)));
  const roast = s.won
    ? (s.hintsUsed ? 'Won with training wheels on. Still counts. Barely.' : 'Pure brain power. Or a lucky guess. We will never know.')
    : s.wrongAttempts > 2 ? 'Bold strategy: try every wrong answer first.'
    : s.attempts === 0 ? 'Thought very hard. Submitted nothing. Very zen.'
    : 'Close enough to taste it, far enough to lose.';
  return { name: s.name, iq, roast };
}
