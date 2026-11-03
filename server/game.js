// The single authoritative game room. Clients only send intents (join, submit, hint, rematch);
// the server owns the timer, validates answers, decides the winner and keeps the scores.
import { judge, tokensToString } from '../shared/expr.js';
import { generatePuzzle } from './generator.js';
import { makeHint } from './hint.js';
import { iqReport } from './iq.js';
import { Bot } from './bot.js';
import { GET_READY_MS, MAX_HINTS, DIFFICULTIES, DEFAULT_DIFFICULTY, BOT_PROMPT_MS } from './config.js';

// Everyone in the room races the same puzzle; a match needs at least two players (or one + the bot).
const MIN_PLAYERS = 2;
const HISTORY_MAX = 8;

export class Game {
  constructor(io, { onChange = () => {} } = {}) {
    this.io = io;
    this.onChange = onChange;
    this.clients = new Map(); // socketId -> { id, nickname, score, socket }
    this.seats = [];          // socket ids racing in the current/next match (no cap)
    this.queue = [];          // socket ids that arrived mid-round; they join at the next round
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
    this.startsAt = null;
    // Bot match interrupted by a human arriving: paused until the bot's player chooses.
    this.paused = null;       // null | { fromPhase: 'playing' | 'ready', remainingMs }
    this.promptTimer = null;  // auto-continue with the bot if the player ignores the prompt
    this.keepBot = false;     // player chose to keep racing the bot; don't re-prompt
    this.bot = null;          // the single AI opponent, if one has been added
    this.autoStart = false;     // the bot's player explicitly chose to race the humans: no extra click
    this.wantsPlay = new Set(); // lobby: seated humans who clicked "Play with other players"
    // Extra features: selectable match mode, win streaks, and recent history.
    this.difficulty = DEFAULT_DIFFICULTY;
    this.streakMode = false;
    this.matchMs = DIFFICULTIES[DEFAULT_DIFFICULTY].ms;
    this.streaks = new Map();           // socketId -> current consecutive wins
    this.history = [];                  // recent finished matches, newest first
    this.adminBotThink = null;          // bot's full solving trace, for the admin page only
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

  // Only a seated human can call in the bot (or send it away below).
  isSeatedHuman(socket) {
    const c = this.clients.get(socket?.id);
    return Boolean(c && !c.isBot && c.nickname && this.seats.includes(socket.id));
  }

  addBot(socket, difficulty) {
    if (!this.isSeatedHuman(socket)) return;
    if (this.bot || this.phase !== 'lobby' || this.seats.length !== 1 || this.queue.length) return;
    const bot = new Bot(this, difficulty);
    this.bot = bot;
    this.clients.set(bot.id, { id: bot.id, nickname: this.uniqueName(bot.nickname), score: 0, socket: bot.socket, isBot: true });
    this.seats.push(bot.id);
    this.broadcastPlayers();
    this.maybeStart();
  }

  // The bot shares how it reasoned and how many tokens it used, for the human it is racing.
  // We compare against the previous LLM round so the player can watch the token cost move.
  botThink({ source, usage, steps, expression, revealMs }) {
    const total = usage?.totalTokens ?? 0;
    const prev = source === 'llm' ? (this.lastBotTokens ?? null) : null;
    if (source === 'llm') this.lastBotTokens = total;
    // The full solving trace is for the server operator only (admin page) — showing it to the
    // player would hand them the answer. Players get a progress bar and the token cost, no steps.
    this.adminBotThink = { matchNo: this.matchNo, source, usage, steps, expression, totalTokens: total };
    const clientPayload = {
      matchNo: this.matchNo, source, usage, revealMs, totalSteps: steps.length,
      totalTokens: total, prevTokens: prev, delta: prev != null ? total - prev : null,
    };
    for (const id of this.seats) {
      const c = this.clients.get(id);
      if (c && !c.isBot) c.socket.emit('bot_think', clientPayload);
    }
    this.changed(); // push the full trace to the admin display
  }

  // Called by a seated human from the end screen ("Back to menu"), or internally.
  requestRemoveBot(socket) {
    if (this.isSeatedHuman(socket)) this.removeBot();
  }

  removeBot(reason = 'The AI opponent left') {
    if (!this.bot) return;
    const id = this.bot.id;
    this.bot.cancel();
    this.clearPrompt();
    this.paused = null;
    this.keepBot = false;
    const wasSeated = this.seats.includes(id);
    this.clients.delete(id);
    this.seats = this.seats.filter((x) => x !== id);
    this.queue = this.queue.filter((x) => x !== id);
    this.bot = null;
    this.streaks.delete(id);
    if (wasSeated && this.phase !== 'lobby') this.abortMatch(reason);
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

    const botMatch = Boolean(this.bot);
    if (botMatch) this.queue.push(socket.id);              // never dropped into someone's bot match
    else if (this.phase === 'lobby') this.seats.push(socket.id);
    else if (this.phase === 'ready' && !this.paused) this.seats.push(socket.id); // still time to join this round
    else this.queue.push(socket.id);                       // mid-match: joins the next round

    socket.emit('welcome', { id: socket.id, nickname: client.nickname, ...this.playersPayload() });
    socket.emit('extras', this.extrasPayload());
    if (this.phase === 'ready' && this.seats.includes(socket.id)) {
      socket.emit('get_ready', { startsAt: this.startsAt, serverNow: Date.now(), matchNo: this.matchNo, mode: this.mode() });
    }
    if (botMatch) return this.offerHumans();
    this.broadcastPlayers();
    this.maybeStart();
  }

  disconnect(socket) {
    const client = this.clients.get(socket.id);
    this.clients.delete(socket.id);
    this.queue = this.queue.filter((id) => id !== socket.id);
    this.wantsPlay.delete(socket.id);
    // The newcomer who interrupted a bot match left again: carry on, and re-ask for the next one.
    if (this.bot && !this.waitingHumans().length && (this.promptTimer || this.paused || this.keepBot)) {
      this.resume();
      this.keepBot = false;
    }
    if (this.seats.includes(socket.id)) {
      this.seats = this.seats.filter((id) => id !== socket.id);
      this.rematchVotes.delete(socket.id);
      // The bot was this player's chosen opponent; it leaves with them rather than being
      // handed to whoever joins next.
      if (this.bot && this.seats.includes(this.bot.id) && !this.seatedHumans().length) {
        this.removeBot(`${client?.nickname ?? 'Your opponent'} left the game`);
        return;
      }
      // The race carries on as long as at least two players are left in it.
      if (this.phase !== 'lobby' && this.seats.length < MIN_PLAYERS) {
        this.abortMatch(`${client?.nickname ?? 'Your opponent'} left the game`);
        this.fillSeats();
      } else if (this.phase === 'finished') {
        return this.checkRematch();
      }
    }
    this.broadcastPlayers();
    this.maybeStart();
  }

  // A seated player gives up and goes back to the home (lobby) screen, in any phase.
  surrender(socket) {
    const client = this.clients.get(socket.id);
    if (!client || client.isBot || !this.seats.includes(socket.id)) return;
    const name = client.nickname ?? 'Your opponent';
    socket.emit('surrendered');
    this.seats = this.seats.filter((id) => id !== socket.id);
    this.rematchVotes.delete(socket.id);
    this.wantsPlay.delete(socket.id);
    this.streaks.delete(socket.id);
    if (this.bot) {                                   // vs the AI: the match just ends
      this.queue.push(socket.id);
      return this.removeBot();                        // aborts the match, refills seats, broadcasts
    }
    this.queue.push(socket.id);
    if (this.phase !== 'lobby' && this.seats.length < MIN_PLAYERS) {
      this.abortMatch(`${name} surrendered`);
      this.fillSeats();
    } else if (this.phase === 'finished') {
      return this.checkRematch();
    }
    this.broadcastPlayers();
    this.maybeStart();
  }

  // ---------- match flow ----------

  maybeStart() {
    if (this.phase !== 'lobby') return;
    this.fillSeats();
    if (this.seats.length < MIN_PLAYERS) return this.changed();
    // Humans are never pulled into a match: it starts once every one of them has opted in.
    if (!this.bot && !this.autoStart && !this.seats.every((id) => this.wantsPlay.has(id))) return this.broadcastPlayers();
    this.beginGetReady();
  }

  // A lobby player clicks "Play with other players".
  playPeople(socket) {
    if (!this.isSeatedHuman(socket) || this.phase !== 'lobby' || this.bot) return;
    this.wantsPlay.add(socket.id);
    this.broadcastPlayers();
    this.maybeStart();
  }

  beginGetReady() {
    this.clearTimers();
    this.wantsPlay.clear();
    this.autoStart = false;
    if (!this.bot) this.fillSeats(); // everyone who waited out the last round joins this one
    // Puzzle is generated before the match begins so the key solution is already on /admin.
    const diff = DIFFICULTIES[this.difficulty] ?? DIFFICULTIES[DEFAULT_DIFFICULTY];
    this.puzzle = generatePuzzle({ targetMin: diff.targetMin, targetMax: diff.targetMax });
    this.matchMs = diff.ms;
    this.matchNo += 1;
    this.phase = 'ready';
    this.adminBotThink = null;
    this.rematchVotes.clear();
    this.winnerId = null;
    this.winningExpr = null;
    this.countdown();
  }

  countdown() {
    this.phase = 'ready';
    this.startsAt = Date.now() + GET_READY_MS;
    this.toSeats('get_ready', { startsAt: this.startsAt, serverNow: Date.now(), matchNo: this.matchNo, mode: this.mode() });
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
    if (this.paused) return socket.emit('submit_rejected', { reason: 'Game paused' });
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
    this.paused = null;
    this.phase = 'lobby';
    this.puzzle = null;
    this.rematchVotes.clear();
    this.toSeats('match_aborted', { reason });
  }

  rematch(socket) {
    if (this.phase !== 'finished' || !this.seats.includes(socket.id)) return;
    this.rematchVotes.add(socket.id);
    this.checkRematch();
  }

  // Everyone still in the race has to agree; a player leaving can complete the vote.
  checkRematch() {
    if (this.phase !== 'finished') return;
    const votes = [...this.rematchVotes].map((id) => this.clients.get(id)?.nickname);
    this.toSeats('rematch_status', { votes, needed: this.seats.length });
    this.broadcastPlayers();
    if (this.seats.length >= MIN_PLAYERS && this.seats.every((id) => this.rematchVotes.has(id))) this.beginGetReady();
    else if (this.seats.length < MIN_PLAYERS) { this.phase = 'lobby'; this.puzzle = null; this.rematchVotes.clear(); this.toSeats('match_aborted', { reason: 'Everyone else left' }); this.fillSeats(); this.broadcastPlayers(); this.maybeStart(); }
  }

  // ---------- human arrives while someone is racing the bot ----------

  seatedHumans() {
    return this.seats.filter((id) => !this.clients.get(id)?.isBot);
  }

  waitingHumans() {
    return this.queue.map((id) => this.clients.get(id)).filter((c) => c && !c.isBot && c.nickname);
  }

  // Pause the bot match and ask its player whether to switch to the newcomer(s).
  offerHumans() {
    const names = this.waitingHumans().map((c) => c.nickname);
    if (!this.bot || !names.length) return this.broadcastPlayers();
    if (this.keepBot || this.promptTimer) return this.broadcastPlayers(); // light banner / open prompt covers it
    if (this.phase === 'playing') {
      const remainingMs = Math.max(0, this.endsAt - Date.now());
      this.clearTimers();
      this.bot.pause();
      this.paused = { fromPhase: 'playing', remainingMs };
    } else if (this.phase === 'ready') {
      this.clearTimers();
      this.paused = { fromPhase: 'ready' };
    }
    this.promptTimer = setTimeout(() => { this.promptTimer = null; this.resume(); }, BOT_PROMPT_MS);
    for (const id of this.seatedHumans()) {
      this.clients.get(id)?.socket.emit('opponent_appeared', { names, paused: Boolean(this.paused), autoMs: BOT_PROMPT_MS });
    }
    this.broadcastPlayers();
  }

  botChoice(socket, choice) {
    if (!this.isSeatedHuman(socket) || !this.bot) return;
    if (choice === 'humans') {
      if (!this.waitingHumans().length) return;
      this.autoStart = true;
      this.removeBot('Switching to the human challenge');
    } else if (choice === 'bot') {
      this.resume();
    }
  }

  // Continue the bot match where it paused.
  resume() {
    this.clearPrompt();
    if (!this.bot) return;
    this.keepBot = true;
    const p = this.paused;
    this.paused = null;
    if (p?.fromPhase === 'playing' && this.phase === 'playing') {
      this.endsAt = Date.now() + p.remainingMs;
      this.timer = setTimeout(() => this.endMatch(null, 'timeout'), p.remainingMs);
      this.bot.resume();
      this.toSeats('match_resumed', { endsAt: this.endsAt, serverNow: Date.now() });
    } else if (p?.fromPhase === 'ready' && this.phase === 'ready') {
      this.countdown(); // same puzzle, fresh countdown
      return;
    }
    this.broadcastPlayers();
  }

  clearPrompt() {
    clearTimeout(this.promptTimer);
    this.promptTimer = null;
  }

  async hint(socket) {
    if (this.phase !== 'playing' || this.paused || !this.seats.includes(socket.id)) return;
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
    this.bot?.cancel(); // the bot isn't on io, so it never hears the 'reset' broadcast below
    this.clearPrompt();
    this.paused = null;
    for (const c of this.clients.values()) c.score = 0;
    this.streaks.clear();
    this.lastBotTokens = null;
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
    if (this.bot) return; // a bot match stays 1-on-1 until its player switches to the humans
    this.seats.push(...this.queue);
    this.queue = [];
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
      id: c.id, nickname: c.nickname, score: c.score, status: this.statusOf(c.id), isBot: !!c.isBot, wantsPlay: this.wantsPlay.has(c.id),
    }));
    return {
      players, online: this.clients.size, phase: this.phase,
      queue: this.queue.map((id) => this.clients.get(id)?.nickname), mode: this.mode(),
      paused: Boolean(this.paused), keepBot: this.keepBot,
    };
  }

  extrasPayload() {
    return { history: this.history, mode: this.mode() };
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
      history: this.history,
      mode: this.mode(),
      botThink: this.adminBotThink,
      match: this.puzzle && {
        digits: this.puzzle.digits,
        target: this.puzzle.target,
        keySolution: this.puzzle.keySolution,
        altSolutions: this.puzzle.altSolutions,
      },
    };
  }
}
