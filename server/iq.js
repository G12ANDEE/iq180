// AI feature: a tongue-in-cheek "IQ" for each player, written by an LLM from their match stats.
// Talks to any OpenAI-compatible chat API (Groq by default, or Ollama/OpenRouter via env vars).
// Falls back to a local formula when there is no API key, the call fails, or it takes too long.
import { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, IQ_TIMEOUT_MS } from './config.js';

// Hosted APIs need a key; a custom endpoint (e.g. local Ollama) may not.
const enabled = Boolean(LLM_API_KEY) || !LLM_BASE_URL.includes('api.groq.com');

const SYSTEM = `You are the sarcastic-but-kind announcer of IQ180, a party math game where players race to
reach a target number using five digits with + - x / and parentheses within 60 seconds.
Given each player's match stats, invent a playful "IQ" (an integer from 60 to 200) and a one-sentence roast
(max 20 words). Faster correct solves, fewer wrong attempts and fewer hints deserve higher IQs.
Keep it light, never mean about anything except their arithmetic. Everyone knows the number is a joke.
Reply with JSON only, exactly this shape, one entry per player, names copied exactly:
{"players":[{"name":"<player name>","iq":<integer>,"roast":"<one sentence>"}]}`;

// stats: [{ name, won, timedOut, attempts, wrongAttempts, hintsUsed, secondsToSolve|null, target, digits }]
export async function iqReport(stats) {
  if (enabled) {
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
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(LLM_API_KEY && { Authorization: `Bearer ${LLM_API_KEY}` }),
    },
    signal: AbortSignal.timeout(IQ_TIMEOUT_MS),
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.9,
      max_tokens: 1500, // headroom: gpt-oss reasons before answering
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Match stats:\n${JSON.stringify(stats, null, 2)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = (await res.json())?.choices?.[0]?.message?.content;
  if (!text) return null;
  const players = JSON.parse(text)?.players;
  if (!Array.isArray(players)) return null;
  // Re-key by the names we sent so a model typo can't drop or swap a player.
  return stats.map((s, i) => {
    const r = players.find((p) => p?.name === s.name) ?? players[i];
    const iq = Number(r?.iq);
    if (!r || !Number.isFinite(iq) || typeof r.roast !== 'string') return fallback(s);
    return { name: s.name, iq: Math.max(60, Math.min(200, Math.round(iq))), roast: r.roast.slice(0, 200) };
  });
}

function fallback(s) {
  let iq = 100;
  if (s.won) iq += 25 + Math.max(0, 60 - (s.secondsToSolve ?? 60)) * 0.6;
  else if (s.timedOut) iq -= 5;
  iq -= s.wrongAttempts * 4 + s.hintsUsed * 8;
  iq = Math.max(60, Math.min(200, Math.round(iq)));
  const roast = s.won
    ? (s.hintsUsed ? 'Won with training wheels on. Still counts. Barely.' : 'Pure brain power. Or a lucky guess. We will never know.')
    : s.wrongAttempts > 2 ? 'Bold strategy: try every wrong answer first.'
    : s.attempts === 0 ? 'Thought very hard. Submitted nothing. Very zen.'
    : 'Close enough to taste it, far enough to lose.';
  return { name: s.name, iq, roast };
}
