// AI opponent. It occupies a normal seat through a fake socket, so the Game emits to it exactly
// like any client (every `?.socket.emit(...)` in game.js just calls onEvent here). On match_start
// it asks the LLM to solve, then submits after a human-like delay set by difficulty.
import { aiSolve } from './bot-brain.js';
import { treeToTokens, treeToString } from '../shared/solver.js';
import { stepsFromTokens } from '../shared/expr.js';
import { BOT_NAME } from './config.js';

// min/max submit delay (ms, measured from the match start) and the chance it bothers to solve.
const LEVELS = {
  easy:   { min: 25_000, max: 50_000, solveProb: 0.5 },
  medium: { min: 12_000, max: 30_000, solveProb: 0.85 },
  hard:   { min: 5_000,  max: 13_000, solveProb: 1 },
};

const rand = (min, max) => min + Math.random() * (max - min);

export class Bot {
  constructor(game, difficulty = 'medium') {
    this.game = game;
    this.difficulty = LEVELS[difficulty] ? difficulty : 'medium';
    this.id = `bot:${Math.random().toString(36).slice(2, 8)}`;
    this.timer = null;
    this.socket = { id: this.id, emit: (event, payload) => this.onEvent(event, payload) };
  }

  get nickname() {
    return this.difficulty === 'medium' ? BOT_NAME : `${BOT_NAME} · ${this.difficulty}`;
  }

  onEvent(event, payload) {
    if (event === 'match_start') this.play(payload);
    else if (['get_ready', 'match_aborted', 'reset'].includes(event)) this.cancel();
    else if (event === 'match_end') { this.cancel(); this.game.rematch(this.socket); } // always up for a rematch
  }

  cancel() { clearTimeout(this.timer); this.timer = null; }

  async play({ matchNo, digits, target, durationMs, endsAt }) {
    this.cancel();
    const level = LEVELS[this.difficulty];
    const willSolve = Math.random() < level.solveProb;
    const startedAt = Date.now();
    // The LLM call can outlive the match it was made for (opponent wins fast, rematch starts).
    // Only act while that same match is still being played by this bot.
    const stillLive = () => this.game.bot === this && this.game.phase === 'playing' && this.game.matchNo === matchNo;

    // Reuse the verified LLM answer; fall back to a known solution so the bot can always act.
    const answer = (await aiSolve(digits, target)) ?? this.fallbackAnswer();
    if (!stillLive()) return;          // stale: a later match is running, or this bot was removed
    if (!answer || !willSolve) return; // no answer, or the bot "can't get it" this round

    const deadline = endsAt ?? startedAt + durationMs;
    const wait = Math.max(0, rand(level.min, level.max) - (Date.now() - startedAt));
    if (Date.now() + wait >= deadline) return; // it would run out of time — stays silent

    // Let the human watch how this AI opponent reasons, and what it cost in tokens.
    try {
      const steps = stepsFromTokens(answer.tokens, digits);
      this.game.botThink({
        source: answer.usage ? 'llm' : 'solver',
        usage: answer.usage ?? null,
        steps,
        expression: answer.expression,
        revealMs: wait,
      });
    } catch { /* never let the commentary break the bot's move */ }

    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!stillLive()) return;
      console.log(`[bot] ${this.nickname} answers: ${answer.expression}`);
      this.game.submit(this.socket, answer.tokens);
    }, wait);
  }

  // A guaranteed-correct answer from the exhaustive solver, used when the LLM is unavailable/wrong.
  fallbackAnswer() {
    const trees = this.game.puzzle?.solutions;
    if (!trees?.length) return null;
    const tree = trees[Math.floor(Math.random() * trees.length)];
    return { expression: treeToString(tree), tokens: treeToTokens(tree) };
  }
}
