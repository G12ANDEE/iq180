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
// IQ roast LLM: any OpenAI-compatible endpoint. Defaults to Groq's free tier; point at Ollama with
// LLM_BASE_URL=http://localhost:11434/v1 (no key needed).
export const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
export const LLM_API_KEY = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-oss-120b';
export const IQ_TIMEOUT_MS = Number(process.env.IQ_TIMEOUT_MS ?? 8_000);
