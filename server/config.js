// Server settings. Env vars override these for tests and demo tweaks.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// server/.env first, then a project-root .env; real env vars always win.
dotenv.config({ path: [fileURLToPath(new URL('./.env', import.meta.url)), fileURLToPath(new URL('../.env', import.meta.url))], quiet: true });

export const PORT = Number(process.env.PORT ?? 3000);
export const MATCH_MS = Number(process.env.MATCH_MS ?? 60_000);
export const GET_READY_MS = Number(process.env.GET_READY_MS ?? 3_000);
export const TARGET_MIN = Number(process.env.TARGET_MIN ?? 1);
export const TARGET_MAX = Number(process.env.TARGET_MAX ?? 99);
export const MAX_HINTS = 2;

// Difficulty modes (a "separate mode" per the brief). "normal" matches the base game exactly,
// so the default experience and the tests are unchanged. Easy gives smaller targets and more
// time; hard gives bigger targets and less time.
export const DIFFICULTIES = {
  easy: { label: 'Easy', targetMin: 1, targetMax: 20, ms: 90_000 },
  normal: { label: 'Normal', targetMin: TARGET_MIN, targetMax: TARGET_MAX, ms: MATCH_MS },
  hard: { label: 'Hard', targetMin: 50, targetMax: 200, ms: 45_000 },
};
export const DEFAULT_DIFFICULTY = 'normal';
// IQ roast LLM: any OpenAI-compatible endpoint. Defaults to Groq's free tier; point at Ollama with
// LLM_BASE_URL=http://localhost:11434/v1 (no key needed).
export const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
export const LLM_API_KEY = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-oss-120b';
// Hints are needed mid-match, so give up quickly and fall back to the solver's wording.
export const HINT_TIMEOUT_MS = Number(process.env.HINT_TIMEOUT_MS ?? 4_000);
export const IQ_TIMEOUT_MS = Number(process.env.IQ_TIMEOUT_MS ?? 8_000);

// AI opponent (free LLM via any OpenAI-compatible endpoint; Groq by default).
export const BOT_BASE_URL = process.env.BOT_BASE_URL ?? 'https://api.groq.com/openai/v1';
export const BOT_MODEL = process.env.BOT_MODEL ?? 'qwen/qwen3.8-27b';
export const BOT_API_KEY = process.env.GROQ_API_KEY ?? process.env.BOT_API_KEY ?? '';
export const BOT_TIMEOUT_MS = Number(process.env.BOT_TIMEOUT_MS ?? 15_000);
export const BOT_NAME = process.env.BOT_NAME ?? '🤖 Groq Bot';
