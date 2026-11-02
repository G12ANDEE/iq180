// Minimal client for any OpenAI-compatible chat API (Groq by default, or Ollama/OpenRouter via env vars).
import { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } from './config.js';

// gpt-oss reasons before answering; 'low' cuts its tokens ~5x, which matters on Groq's 8k tokens/min free tier.
// Other models (e.g. qwen) would start reasoning if sent this flag, so it's only on for gpt-oss unless overridden.
const REASONING_EFFORT = process.env.LLM_REASONING_EFFORT ?? (LLM_MODEL.includes('gpt-oss') ? 'low' : '');

// Hosted APIs need a key; a custom endpoint (e.g. local Ollama) may not.
export const llmEnabled = Boolean(LLM_API_KEY) || !LLM_BASE_URL.includes('api.groq.com');

// Sends one system + user message and returns the reply parsed as JSON. Throws on HTTP/network/timeout errors.
export async function chatJSON({ system, user, timeoutMs, maxTokens = 1500, temperature = 0.9 }) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(LLM_API_KEY && { Authorization: `Bearer ${LLM_API_KEY}` }),
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature,
      max_tokens: maxTokens, // keep headroom: reasoning models (gpt-oss) think before answering
      response_format: { type: 'json_object' },
      ...(REASONING_EFFORT && { reasoning_effort: REASONING_EFFORT }),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = (await res.json())?.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty reply');
  return JSON.parse(text);
}
