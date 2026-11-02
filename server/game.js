// The single authoritative game room. Clients only send intents (join, submit, hint, rematch);
// the server owns the timer, validates answers, decides the winner and keeps the scores.
import { judge, tokensToString } from '../shared/expr.js';
import { generatePuzzle } from './generator.js';
import { makeHint } from './hint.js';
import { iqReport } from './iq.js';
import { MATCH_MS, GET_READY_MS, MAX_HINTS } from './config.js';

const SEATS = 2;

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
  }

  // ---------- connection lifecycle ----------

  connect(socket) {
    this.clients.set(socket.id, { id: socket.id, nickname: null, score: 0, socket });
    socket.emit('players_update', this.playersPayload());
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
    this.puzzle = generatePuzzle();
    this.matchNo += 1;
    this.phase = 'ready';
    this.rematchVotes.clear();
    this.winnerId = null;
    this.winningExpr = null;
    const startsAt = Date.now() + GET_READY_MS;
    this.toSeats('get_ready', { startsAt, serverNow: Date.now(), opponent: null, matchNo: this.matchNo });
    this.broadcastPlayers();
    this.readyTimer = setTimeout(() => this.startMatch(), GET_READY_MS);
  }

  startMatch() {
    this.phase = 'playing';
    this.startedAt = Date.now();
    this.endsAt = this.startedAt + MATCH_MS;
    this.stats = new Map(this.seats.map((id) => [id, { attempts: 0, wrongAttempts: 0, hintsUsed: 0, hintTree: null, solvedAt: null }]));
    this.toSeats('match_start', {
      matchNo: this.matchNo,
      digits: this.puzzle.digits,
      target: this.puzzle.target,
      endsAt: this.endsAt,
      serverNow: Date.now(),
      durationMs: MATCH_MS,
      maxHints: MAX_HINTS,
      scores: this.scores(),
    });
    this.broadcastPlayers();
    this.timer = setTimeout(() => this.endMatch(null, 'timeout'), MATCH_MS);
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
    if (winner) winner.score += 1;
    const base = {
      matchNo: this.matchNo,
      reason,
      winner: winner?.nickname ?? null,
      winningExpression: this.winningExpr,
      keySolution: this.puzzle.keySolution,
      target: this.puzzle.target,
      scores: this.scores(),
    };
    for (const id of this.seats) {
      this.clients.get(id)?.socket.emit('match_end', { ...base, result: id === winnerId ? 'win' : 'lost' });
    }
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

  async hint(socket) {
    if (this.phase !== 'playing' || !this.seats.includes(socket.id)) return;
    const st = this.stats.get(socket.id);
    if (st.hintsUsed >= MAX_HINTS) return socket.emit('hint', { text: null, used: st.hintsUsed, max: MAX_HINTS });
    st.hintTree ??= this.puzzle.solutions[Math.floor(Math.random() * this.puzzle.solutions.length)];
    const index = st.hintsUsed;
    st.hintsUsed += 1; // count before the await so a double-click can't get a free hint
    const matchNo = this.matchNo;
    const { text, source } = await makeHint({ tree: st.hintTree, index, digits: this.puzzle.digits, target: this.puzzle.target });
    if (this.matchNo !== matchNo || this.phase !== 'playing') return; // match ended while the LLM was thinking
    socket.emit('hint', { text, source, used: index + 1, max: MAX_HINTS }); // private to this player
  }

  reset() {
    this.clearTimers();
    for (const c of this.clients.values()) c.score = 0;
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
      id: c.id, nickname: c.nickname, score: c.score, status: this.statusOf(c.id),
    }));
    return { players, online: this.clients.size, phase: this.phase, queue: this.queue.map((id) => this.clients.get(id)?.nickname) };
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
      match: this.puzzle && {
        digits: this.puzzle.digits,
        target: this.puzzle.target,
        keySolution: this.puzzle.keySolution,
        altSolutions: this.puzzle.altSolutions,
      },
    };
  }
}
