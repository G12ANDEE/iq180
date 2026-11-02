// The single authoritative game room. Clients only send intents (join, submit, hint, rematch);
// the server owns the timer, validates answers, decides the winner and keeps the scores.
import { judge, tokensToString } from '../shared/expr.js';
import { generatePuzzle, hintsFor } from './generator.js';
import { iqReport } from './iq.js';
import { Bot } from './bot.js';
import { Leaderboard } from './leaderboard.js';
import { GET_READY_MS, MAX_HINTS, DIFFICULTIES, DEFAULT_DIFFICULTY } from './config.js';

const SEATS = 2;
const HISTORY_MAX = 8;

export class Game {
  constructor(io, { onChange = () => {} } = {}) {
    this.io = io;
    this.onChange = onChange;
    this.clients = new Map(); // socketId -> { id, nickname, score, socket }
    this.seats = [];          // socket ids of the two active players
    this.queue = [];          // socket ids waiting for a seat
    this.phase = 'lobby';     // lobby | ready | playing | finished
    this.puzzle = null;
    this.matchNo = 0;
    this.endsAt = null;
    this.startedAt = null;
    this.winnerId = null;
    this.winningExpr = null;
    this.rematchVotes = new Set();
    this.stats = new Map();   // socketId -> { attempts, wrongAttempts, hintsUsed, hintTree, solvedAt }
    this.timer = null;
    this.readyTimer = null;
    this.bot = null;          // the single AI opponent, if one has been added
    // Extra features: selectable match mode, win streaks, recent history and an all-time board.
    this.difficulty = DEFAULT_DIFFICULTY;
    this.streakMode = false;
    this.matchMs = DIFFICULTIES[DEFAULT_DIFFICULTY].ms;
    this.streaks = new Map();           // socketId -> current consecutive wins
    this.history = [];                  // recent finished matches, newest first
    this.leaderboard = new Leaderboard();
  }

  // ---------- match mode (difficulty + streak bonus) ----------

  // A seated player picks the mode from the lobby; it applies to the next match.
  setMode(socket, { difficulty, streakMode } = {}) {
    if (!this.seats.includes(socket.id)) return;
    if (this.phase === 'playing' || this.phase === 'ready') return;
    if (difficulty && DIFFICULTIES[difficulty]) this.difficulty = difficulty;
    if (typeof streakMode === 'boolean') this.streakMode = streakMode;
    this.broadcastPlayers();
  }

  mode() {
    return { difficulty: this.difficulty, streakMode: this.streakMode, difficulties: this.difficultyList() };
  }

  difficultyList() {
    return Object.entries(DIFFICULTIES).map(([key, d]) => ({ key, label: d.label, seconds: Math.round(d.ms / 1000) }));
  }

  // ---------- AI opponent ----------

  addBot(difficulty) {
    if (this.bot || this.phase !== 'lobby' || this.seats.length >= SEATS) return;
    const bot = new Bot(this, difficulty);
    this.bot = bot;
    this.clients.set(bot.id, { id: bot.id, nickname: this.uniqueName(bot.nickname), score: 0, socket: bot.socket, isBot: true });
    this.seats.push(bot.id);
    this.broadcastPlayers();
    this.maybeStart();
  }

  removeBot() {
    if (!this.bot) return;
    const id = this.bot.id;
    this.bot.cancel();
    const wasSeated = this.seats.includes(id);
    this.clients.delete(id);
    this.seats = this.seats.filter((x) => x !== id);
    this.queue = this.queue.filter((x) => x !== id);
    this.bot = null;
    if (wasSeated && this.phase !== 'lobby') this.abortMatch('The AI opponent left');
    this.fillSeats();
    this.broadcastPlayers();
    this.maybeStart();
  }

  // ---------- connection lifecycle ----------

  connect(socket) {
    this.clients.set(socket.id, { id: socket.id, nickname: null, score: 0, socket });
    socket.emit('players_update', this.playersPayload());
    socket.emit('extras', this.extrasPayload());
    this.changed();
  }

  join(socket, nickname) {
    const client = this.clients.get(socket.id);
    if (!client) return;
    if (client.nickname) return socket.emit('join_error', { reason: 'You already joined' });
    const clean = String(nickname ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
    if (!clean) return socket.emit('join_error', { reason: 'Please enter a nickname' });
    client.nickname = this.uniqueName(clean);

    if (this.seats.length < SEATS && (this.phase === 'lobby')) this.seats.push(socket.id);
    else this.queue.push(socket.id);

    socket.emit('welcome', { id: socket.id, nickname: client.nickname, ...this.playersPayload() });
    socket.emit('extras', this.extrasPayload());
    this.broadcastPlayers();
    this.maybeStart();
  }

  disconnect(socket) {
    const client = this.clients.get(socket.id);
    this.clients.delete(socket.id);
    this.queue = this.queue.filter((id) => id !== socket.id);
    if (this.seats.includes(socket.id)) {
      this.seats = this.seats.filter((id) => id !== socket.id);
      if (this.phase !== 'lobby') this.abortMatch(`${client?.nickname ?? 'Your opponent'} left the game`);
      this.fillSeats();
    }
    // The bot shouldn't linger alone once every human has left.
    if (this.bot && ![...this.clients.values()].some((c) => !c.isBot)) return this.removeBot();
    this.broadcastPlayers();
    this.maybeStart();
  }

  // ---------- match flow ----------

  maybeStart() {
    if (this.phase !== 'lobby') return;
    this.fillSeats();
    if (this.seats.length < SEATS) return this.changed();
    this.beginGetReady();
  }

  beginGetReady() {
    this.clearTimers();
    // Puzzle is generated before the match begins so the key solution is already on /admin.
    const diff = DIFFICULTIES[this.difficulty] ?? DIFFICULTIES[DEFAULT_DIFFICULTY];
    this.puzzle = generatePuzzle({ targetMin: diff.targetMin, targetMax: diff.targetMax });
    this.matchMs = diff.ms;
    this.matchNo += 1;
    this.phase = 'ready';
    this.rematchVotes.clear();
    this.winnerId = null;
    this.winningExpr = null;
    const startsAt = Date.now() + GET_READY_MS;
    this.toSeats('get_ready', { startsAt, serverNow: Date.now(), opponent: null, matchNo: this.matchNo, mode: this.mode() });
    this.broadcastPlayers();
    this.readyTimer = setTimeout(() => this.startMatch(), GET_READY_MS);
  }

  startMatch() {
    this.phase = 'playing';
    this.startedAt = Date.now();
    this.endsAt = this.startedAt + this.matchMs;
    this.stats = new Map(this.seats.map((id) => [id, { attempts: 0, wrongAttempts: 0, hintsUsed: 0, hintTree: null, solvedAt: null }]));
    this.toSeats('match_start', {
      matchNo: this.matchNo,
      digits: this.puzzle.digits,
      target: this.puzzle.target,
      endsAt: this.endsAt,
      serverNow: Date.now(),
      durationMs: this.matchMs,
      maxHints: MAX_HINTS,
      scores: this.scores(),
      mode: this.mode(),
    });
    this.broadcastPlayers();
    this.timer = setTimeout(() => this.endMatch(null, 'timeout'), this.matchMs);
  }

  submit(socket, tokens) {
    if (this.phase !== 'playing' || !this.seats.includes(socket.id)) {
      return socket.emit('submit_rejected', { reason: 'No match in progress' });
    }
    if (Date.now() > this.endsAt) return socket.emit('submit_rejected', { reason: "Time's up" });
    const st = this.stats.get(socket.id);
    st.attempts += 1;
    const verdict = judge(tokens, this.puzzle.digits, this.puzzle.target);
    if (!verdict.ok) {
      st.wrongAttempts += 1;
      return socket.emit('submit_rejected', { reason: verdict.reason });
    }
    // Node handles one event at a time, so the first correct submission received wins outright.
    st.solvedAt = Date.now();
    this.winningExpr = tokensToString(tokens, this.puzzle.digits);
    this.endMatch(socket.id, 'solved');
  }

  endMatch(winnerId, reason) {
    if (this.phase !== 'playing') return;
    this.clearTimers();
    this.phase = 'finished';
    this.winnerId = winnerId;
    const winner = winnerId ? this.clients.get(winnerId) : null;

    // Win streaks: the winner's streak grows, everyone else's resets. On a timeout both reset.
    let streak = 0;
    for (const id of this.seats) {
      if (id === winnerId) { streak = (this.streaks.get(id) ?? 0) + 1; this.streaks.set(id, streak); }
      else this.streaks.set(id, 0);
    }
    // In streak mode a win is worth its streak length (1, 2, 3…); otherwise a flat point.
    const pointsAwarded = winner ? (this.streakMode ? streak : 1) : 0;
    if (winner) winner.score += pointsAwarded;
    if (winner && !winner.isBot) this.leaderboard.recordWin(winner.nickname, streak);

    const base = {
      matchNo: this.matchNo,
      reason,
      winner: winner?.nickname ?? null,
      winningExpression: this.winningExpr,
      keySolution: this.puzzle.keySolution,
      target: this.puzzle.target,
      scores: this.scores(),
      streakMode: this.streakMode,
      pointsAwarded,
      streak: this.streakMode ? streak : 0,
    };
    for (const id of this.seats) {
      this.clients.get(id)?.socket.emit('match_end', { ...base, result: id === winnerId ? 'win' : 'lost' });
    }

    this.history.unshift({
      matchNo: this.matchNo,
      digits: this.puzzle.digits,
      target: this.puzzle.target,
      winner: winner?.nickname ?? null,
      winningExpression: winner ? this.winningExpr : null,
      keySolution: this.puzzle.keySolution,
      difficulty: this.difficulty,
      timedOut: !winner,
    });
    this.history = this.history.slice(0, HISTORY_MAX);

    this.broadcastExtras();
    this.broadcastPlayers();
    this.sendIqReport();
  }

  abortMatch(reason) {
    this.clearTimers();
    this.phase = 'lobby';
    this.puzzle = null;
    this.rematchVotes.clear();
    this.toSeats('match_aborted', { reason });
  }

  rematch(socket) {
    if (this.phase !== 'finished' || !this.seats.includes(socket.id)) return;
    this.rematchVotes.add(socket.id);
    const votes = [...this.rematchVotes].map((id) => this.clients.get(id)?.nickname);
    this.toSeats('rematch_status', { votes, needed: SEATS });
    this.changed();
    if (this.seats.every((id) => this.rematchVotes.has(id))) this.beginGetReady();
  }

  hint(socket) {
    if (this.phase !== 'playing' || !this.seats.includes(socket.id)) return;
    const st = this.stats.get(socket.id);
    if (st.hintsUsed >= MAX_HINTS) return socket.emit('hint', { text: null, used: st.hintsUsed, max: MAX_HINTS });
    st.hintTree ??= this.puzzle.solutions[Math.floor(Math.random() * this.puzzle.solutions.length)];
    const hints = hintsFor(st.hintTree);
    const text = hints[Math.min(st.hintsUsed, hints.length - 1)];
    st.hintsUsed += 1;
    socket.emit('hint', { text, used: st.hintsUsed, max: MAX_HINTS }); // private to this player
  }

  reset() {
    this.clearTimers();
    for (const c of this.clients.values()) c.score = 0;
    this.streaks.clear();
    this.phase = 'lobby';
    this.puzzle = null;
    this.rematchVotes.clear();
    this.winnerId = null;
    this.io.emit('reset', { message: 'The server reset the game. Scores are back to 0.' });
    this.broadcastPlayers();
    this.maybeStart();
  }

  async sendIqReport() {
    const matchNo = this.matchNo;
    const stats = this.seats.map((id) => {
      const c = this.clients.get(id), st = this.stats.get(id);
      return {
        name: c.nickname,
        won: id === this.winnerId,
        timedOut: !this.winnerId,
        attempts: st.attempts,
        wrongAttempts: st.wrongAttempts,
        hintsUsed: st.hintsUsed,
        secondsToSolve: st.solvedAt ? Math.round((st.solvedAt - this.startedAt) / 100) / 10 : null,
        target: this.puzzle.target,
        digits: this.puzzle.digits,
      };
    });
    const report = await iqReport(stats);
    if (this.matchNo !== matchNo || this.phase !== 'finished') return; // a new match already started
    this.toSeats('iq_report', { matchNo, ...report });
  }

  // ---------- helpers ----------

  fillSeats() {
    while (this.seats.length < SEATS && this.queue.length) this.seats.push(this.queue.shift());
  }

  uniqueName(name) {
    const taken = new Set([...this.clients.values()].map((c) => c.nickname?.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
  }

  clearTimers() {
    clearTimeout(this.timer);
    clearTimeout(this.readyTimer);
    this.timer = this.readyTimer = null;
  }

  toSeats(event, payload) {
    for (const id of this.seats) this.clients.get(id)?.socket.emit(event, payload);
  }

  scores() {
    return this.seats.map((id) => {
      const c = this.clients.get(id);
      return { id, nickname: c.nickname, score: c.score };
    });
  }

  statusOf(id) {
    if (this.seats.includes(id)) return this.phase === 'lobby' ? 'ready' : 'playing';
    if (this.queue.includes(id)) return 'waiting';
    return 'joining';
  }

  playersPayload() {
    const players = [...this.clients.values()].map((c) => ({
      id: c.id, nickname: c.nickname, score: c.score, status: this.statusOf(c.id), isBot: !!c.isBot,
    }));
    return { players, online: this.clients.size, phase: this.phase, queue: this.queue.map((id) => this.clients.get(id)?.nickname), mode: this.mode() };
  }

  extrasPayload() {
    return { leaderboard: this.leaderboard.top(10), history: this.history, mode: this.mode() };
  }

  broadcastExtras() {
    this.io.emit('extras', this.extrasPayload());
  }

  broadcastPlayers() {
    this.io.emit('players_update', this.playersPayload());
    this.changed();
  }

  changed() { this.onChange(this.adminState()); }

  adminState() {
    return {
      ...this.playersPayload(),
      matchNo: this.matchNo,
      endsAt: this.endsAt,
      serverNow: Date.now(),
      rematchVotes: [...this.rematchVotes].map((id) => this.clients.get(id)?.nickname),
      winner: this.winnerId ? this.clients.get(this.winnerId)?.nickname : null,
      leaderboard: this.leaderboard.top(10),
      history: this.history,
      mode: this.mode(),
      match: this.puzzle && {
        digits: this.puzzle.digits,
        target: this.puzzle.target,
        keySolution: this.puzzle.keySolution,
        altSolutions: this.puzzle.altSolutions,
      },
    };
  }
}
