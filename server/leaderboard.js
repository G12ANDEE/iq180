// All-time wins per nickname, persisted to disk so they survive a server restart.
// Every disk operation is wrapped: if the data file is missing or unwritable the
// leaderboard simply lives in memory, so it can never crash a match.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('./data/leaderboard.json', import.meta.url));
const DIR = fileURLToPath(new URL('./data', import.meta.url));

export class Leaderboard {
  constructor() {
    this.wins = new Map(); // nickname -> { wins, bestStreak }
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8'));
      for (const row of raw) this.wins.set(row.name, { wins: row.wins | 0, bestStreak: row.bestStreak | 0 });
    } catch {
      /* no file yet, or it is unreadable: start empty */
    }
  }

  save() {
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify(this.top(1000), null, 2));
    } catch (err) {
      console.warn(`[leaderboard] could not save: ${err?.message ?? err}`);
    }
  }

  // Record a win. `streak` is the player's current win streak so we can track their best.
  recordWin(name, streak = 1) {
    if (!name) return;
    const row = this.wins.get(name) ?? { wins: 0, bestStreak: 0 };
    row.wins += 1;
    row.bestStreak = Math.max(row.bestStreak, streak);
    this.wins.set(name, row);
    this.save();
  }

  // Highest wins first, then best streak, then name. Returns plain objects for the wire.
  top(limit = 10) {
    return [...this.wins.entries()]
      .map(([name, r]) => ({ name, wins: r.wins, bestStreak: r.bestStreak }))
      .sort((a, b) => b.wins - a.wins || b.bestStreak - a.bestStreak || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
}
