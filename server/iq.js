// AI feature: a tongue-in-cheek "IQ" for each player, written by Claude from their match stats.
// Falls back to a local formula when there is no API key, the call fails, or it takes too long.
import Anthropic from '@anthropic-ai/sdk';
import { IQ_MODEL, IQ_TIMEOUT_MS } from './config.js';

const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = hasCredentials ? new Anthropic({ timeout: IQ_TIMEOUT_MS, maxRetries: 0 }) : null;

const SYSTEM = `You are the sarcastic-but-kind announcer of IQ180, a party math game where players race to
reach a target number using five digits with + - x / and parentheses within 60 seconds.
Given each player's match stats, invent a playful "IQ" (an integer from 60 to 200) and a one-sentence roast
(max 20 words). Faster correct solves, fewer wrong attempts and fewer hints deserve higher IQs.
Keep it light, never mean about anything except their arithmetic. Everyone knows the number is a joke.`;

const SCHEMA = {
  type: 'object',
  properties: {
    players: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, iq: { type: 'integer' }, roast: { type: 'string' } },
        required: ['name', 'iq', 'roast'],
        additionalProperties: false,
      },
    },
  },
  required: ['players'],
  additionalProperties: false,
};

// stats: [{ name, won, timedOut, attempts, wrongAttempts, hintsUsed, secondsToSolve|null, target, digits }]
export async function iqReport(stats) {
  if (client) {
    try {
      const reports = await askClaude(stats);
      if (reports) return { source: 'ai', reports };
    } catch (err) {
      console.warn(`[iq] Claude call failed, using fallback: ${err?.status ?? ''} ${err?.message ?? err}`);
    }
  }
  return { source: 'formula', reports: stats.map(fallback) };
}

async function askClaude(stats) {
  const response = await client.beta.messages.create({
    model: IQ_MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Match stats:\n${JSON.stringify(stats, null, 2)}` }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) return null;
  const parsed = JSON.parse(text);
  // Re-key by the names we sent so a model typo can't drop or swap a player.
  return stats.map((s, i) => {
    const r = parsed.players.find((p) => p.name === s.name) ?? parsed.players[i];
    if (!r) return fallback(s);
    return { name: s.name, iq: Math.max(60, Math.min(200, Math.round(r.iq))), roast: String(r.roast).slice(0, 200) };
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
