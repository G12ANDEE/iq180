// IQ180 client: a view of server state. It never decides correctness or time; it only renders
// what the server says and sends intents (join, submit, hint, rematch).
import './style.css';
import { connectToServer } from './net.js';
import { evaluate, checkTokens } from '../../shared/expr.js';
import { sfx, isMuted, setMuted } from './sound.js';

const app = document.getElementById('app');
const OPS = [['+', '+'], ['-', '−'], ['x', '×'], ['/', '÷']];

// Theme switcher: one of a few palettes, remembered across visits. Applied as data-theme on <html>.
const THEMES = ['cobalt', 'neon', 'sunset'];
const THEME_LABEL = { cobalt: '🕹 Arcade', neon: '🟣 Neon', sunset: '🌅 Amber' };
function applyTheme(name) {
  const t = THEMES.includes(name) ? name : 'cobalt';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('iq180:theme', t);
  state.theme = t;
}
function cycleTheme() {
  applyTheme(THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]);
  render();
}

const state = {
  screen: 'connecting', // connecting | nickname | lobby | ready | match | end
  server: null,
  me: null,               // { id, nickname }
  players: [], queue: [], online: 0,
  joinError: '',
  readyAt: 0,
  match: null,            // { digits, target, endsAt, offset, maxHints, matchNo }
  tokens: [],
  hints: [],
  feedback: null,         // { text, bad }
  end: null,
  iq: null,
  votes: [],
  banner: null,
  // Extra features
  leaderboard: [], history: [], mode: null,
  theme: localStorage.getItem('iq180:theme') ?? 'cobalt',
  muted: isMuted(),
  paused: false,          // server paused a bot match because a human showed up
  invite: null,           // { names, deadline } — the "Opponent appeared!" prompt
  botThink: null,         // bot progress + token usage while racing the AI opponent (no steps — those are admin-only)
};

let socket;
let clockTimer;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opLabel = (v) => OPS.find(([k]) => k === v)?.[1] ?? v;
const serverNow = () => Date.now() + (state.match?.offset ?? 0);

// ---------- connection & server events ----------

async function boot() {
  applyTheme(state.theme);
  render();
  const conn = await connectToServer((url) => { state.server = url; render(); });
  socket = conn.socket;
  state.server = conn.url;
  state.screen = 'nickname';
  render();

  socket.on('players_update', (p) => {
    const wasPaused = state.paused;
    Object.assign(state, { players: p.players, queue: p.queue, online: p.online, mode: p.mode ?? state.mode, paused: Boolean(p.paused) });
    if (!waitingHumans().length) state.invite = null; // the newcomer left again
    if (state.paused && !wasPaused && state.match) state.match.pausedLeft = Math.max(0, state.match.endsAt - serverNow());
    if (['lobby', 'match', 'end', 'ready'].includes(state.screen)) renderSoft();
  });
  socket.on('opponent_appeared', ({ names, autoMs }) => {
    state.invite = { names, deadline: Date.now() + autoMs };
    sfx.hint();
    render();
    tickInvite();
  });
  socket.on('match_resumed', ({ endsAt, serverNow: sn }) => {
    state.invite = null;
    state.paused = false;
    if (state.match) Object.assign(state.match, { endsAt, offset: sn - Date.now(), pausedLeft: null });
    render();
  });
  socket.on('extras', (e) => { Object.assign(state, { leaderboard: e.leaderboard ?? [], history: e.history ?? [], mode: e.mode ?? state.mode }); if (['lobby', 'end'].includes(state.screen)) renderSoft(); });
  socket.on('join_error', ({ reason }) => { state.joinError = reason; render(); });
  socket.on('welcome', (p) => {
    state.me = { id: p.id, nickname: p.nickname };
    Object.assign(state, { players: p.players, queue: p.queue, online: p.online, screen: 'lobby', joinError: '' });
    render();
  });
  socket.on('get_ready', ({ startsAt, serverNow: sn }) => {
    state.readyAt = Date.now() + (startsAt - sn);
    Object.assign(state, { screen: 'ready', end: null, iq: null, votes: [], botThink: null, invite: null, paused: false });
    render();
    tickClock();
  });
  socket.on('match_start', (m) => {
    state.match = { ...m, offset: m.serverNow - Date.now() };
    if (m.mode) state.mode = m.mode;
    Object.assign(state, { screen: 'match', tokens: [], hints: [], feedback: null, end: null, iq: null, votes: [], botThink: null });
    sfx.go();
    render();
    tickClock();
  });
  socket.on('submit_rejected', ({ reason }) => { if (state.screen === 'match') { state.feedback = { text: reason, bad: true }; renderSoft(); } });
  socket.on('hint', ({ text, source }) => { if (text) { state.hints.push({ text, ai: source === 'ai' }); sfx.hint(); } else state.feedback = { text: 'No hints left this round', bad: true }; render(); });
  socket.on('bot_think', (p) => {
    if (state.screen !== 'match' || p.matchNo !== state.match?.matchNo) return;
    // Players only get progress + token cost. The actual steps go to the admin page so the
    // opponent's working is never revealed mid-match.
    state.botThink = { ...p, startedAt: Date.now() };
    renderSoft();
  });
  socket.on('match_end', (e) => {
    state.end = e; state.screen = 'end'; (e.result === 'win' ? sfx.win : sfx.lose)(); render();
  });
  socket.on('iq_report', (r) => { if (r.matchNo === state.end?.matchNo) { state.iq = r; render(); } });
  socket.on('rematch_status', ({ votes }) => { state.votes = votes; render(); });
  socket.on('match_aborted', ({ reason }) => { state.invite = null; state.paused = false; flash(`${reason}. Back to the lobby.`); state.screen = 'lobby'; state.match = null; render(); });
  socket.on('reset', ({ message }) => { state.invite = null; state.paused = false; flash(message); state.screen = 'lobby'; state.match = null; state.end = null; render(); });
  socket.on('disconnect', () => { flash('Connection lost. Reconnecting…', 0); });
  socket.io.on('reconnect', () => {
    flash('Reconnected', 2000);
    // The server treats a reconnect as a new client, so rejoin with the same nickname.
    if (state.me) { state.screen = 'lobby'; socket.emit('join', { nickname: state.me.nickname }); state.me = null; }
  });
}

function flash(text, ms = 3500) {
  state.banner = text;
  render();
  clearTimeout(flash.t);
  if (ms) flash.t = setTimeout(() => { state.banner = null; render(); }, ms);
}

// ---------- expression building (local only; server re-checks everything) ----------

const usedSlots = () => new Set(state.tokens.filter((t) => t.t === 'digit').map((t) => t.i));

function push(tok) {
  if (state.screen !== 'match' || state.paused) return;
  if (tok.t === 'digit' && usedSlots().has(tok.i)) return;
  state.tokens.push(tok);
  state.pushedAt = Date.now();
  state.feedback = null;
  (tok.t === 'digit' ? sfx.tap : sfx.op)();
  renderSoft();
}
function pressDigitKey(d) {
  const used = usedSlots();
  const i = state.match.digits.findIndex((v, idx) => v === d && !used.has(idx));
  if (i >= 0) push({ t: 'digit', i });
}
function undo() { state.tokens.pop(); state.feedback = null; renderSoft(); }
function clearExpr() { state.tokens = []; state.feedback = null; renderSoft(); }
function submit() {
  if (!state.tokens.length || state.paused) return;
  socket.emit('submit', { tokens: state.tokens });
  sfx.submit();
  state.feedback = { text: 'Checking…', bad: false };
  renderSoft();
}

function previewText() {
  const { digits, target } = state.match;
  if (!state.tokens.length) return { text: '', hit: false };
  try {
    const v = evaluate(state.tokens, digits);
    const missing = checkTokens(state.tokens, digits);
    const hit = !missing && v.isInteger() && v.num === target;
    return { text: hit ? 'That hits the target. Submit it!' : `= ${v}${missing ? ` · ${missing.toLowerCase()}` : ''}`, hit };
  } catch {
    return { text: '…', hit: false };
  }
}

// ---------- clock ----------

function tickClock() {
  clearInterval(clockTimer);
  const update = () => {
    if (state.screen === 'ready') {
      const s = Math.max(0, Math.ceil((state.readyAt - Date.now()) / 1000));
      const el = document.querySelector('.countdown-big');
      if (el) el.textContent = s || 'Go!';
    } else if (state.screen === 'match') {
      const ms = state.paused ? (state.match.pausedLeft ?? 0) : Math.max(0, state.match.endsAt - serverNow());
      const el = document.querySelector('.clock');
      if (el) {
        const s = Math.ceil(ms / 1000);
        el.textContent = `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        el.classList.toggle('low', s <= 10);
        if (s > 0 && s <= 5 && s !== tickClock.last) { tickClock.last = s; sfx.tick(); }
      }
      if (state.botThink) {
        const pct = botProgress(state.botThink);
        const fill = document.querySelector('.botfill');
        if (fill) fill.style.width = `${pct}%`;
        const label = document.querySelector('.botlabel');
        if (label && pct >= 100) label.textContent = 'Bot has an answer ready';
      }
    } else clearInterval(clockTimer);
  };
  update();
  clockTimer = setInterval(update, 200);
}

function tickInvite() {
  clearInterval(tickInvite.t);
  tickInvite.t = setInterval(() => {
    if (!state.invite) return clearInterval(tickInvite.t);
    const el = document.querySelector('.invite-auto');
    if (el) el.textContent = `Continuing with the bot in ${Math.max(0, Math.ceil((state.invite.deadline - Date.now()) / 1000))}s`;
  }, 250);
}

// ---------- views ----------

const botSeated = () => state.players.some((p) => p.isBot && p.status !== 'waiting');
const waitingHumans = () => state.players.filter((p) => p.status === 'waiting' && !p.isBot && p.id !== state.me?.id);
const iAmSeated = () => ['ready', 'playing'].includes(state.players.find((p) => p.id === state.me?.id)?.status);
const names = (list) => list.map((p) => esc(p.nickname)).join(', ');

// The "Opponent appeared!" prompt: shown to whoever is racing the bot when a person joins.
function inviteHtml() {
  if (!state.invite || !botSeated() || !iAmSeated()) return '';
  const who = state.invite.names.map(esc).join(', ');
  return `<div class="invite-backdrop" role="dialog" aria-modal="true" aria-labelledby="invite-h">
    <div class="invite">
      <div class="ico">👋</div>
      <h2 id="invite-h">Opponent appeared!</h2>
      <p><strong>${who}</strong> wants to race. ${state.paused ? 'Your bot match is paused.' : ''}</p>
      <div class="invite-btns">
        <button class="primary" data-act="joinhumans">Join the challenge</button>
        <button class="ghost" data-act="keepbot">Continue with bot</button>
      </div>
      <p class="invite-auto"></p>
    </div>
  </div>`;
}

// Light banner after choosing to keep the bot: switch to the people waiting at any time.
function waitingStripHtml() {
  const w = waitingHumans();
  if (state.invite || !w.length || !botSeated() || !iAmSeated()) return '';
  return `<div class="waitstrip" role="status">
    <span>👋 <strong>${names(w)}</strong> ${w.length === 1 ? 'is' : 'are'} waiting to play</span>
    <button class="chipbtn" data-act="joinhumans">Play with players</button>
  </div>`;
}

const topbar = () => `
  <header class="topbar">
    <h1 class="brand">IQ180</h1>
    ${state.me ? `<div class="me">Playing as <strong>${esc(state.me.nickname)}</strong> · score <strong>${myScore()}</strong></div>` : ''}
    <div class="toggles">
      <button class="chipbtn" data-act="theme" title="Change theme">${THEME_LABEL[state.theme]}</button>
      <button class="chipbtn" data-act="mute" title="Toggle sound" aria-pressed="${state.muted}">${state.muted ? '🔇 Muted' : '🔊 Sound'}</button>
    </div>
  </header>`;

const myScore = () => state.players.find((p) => p.id === state.me?.id)?.score ?? 0;

function viewConnecting() {
  return `<div class="hero"><h1 class="brand">IQ180</h1></div>
    <p class="connecting">Connecting to the game server${state.server ? ` at ${esc(state.server.replace(/^https?:\/\//, ''))}` : ''}…</p>`;
}

function viewNickname() {
  return `<section class="hero">
    <h1 class="brand">IQ180</h1>
    <p>Five digits. One target. Sixty seconds. Use every digit exactly once with + − × ÷ and brackets, and beat your opponent to it.</p>
    <form class="join" id="join">
      <label for="nick" class="sr">Nickname</label>
      <input id="nick" name="nick" maxlength="16" autocomplete="off" placeholder="Your nickname" required autofocus />
      <button class="primary" type="submit">Join game</button>
    </form>
    <div class="error">${esc(state.joinError)}</div>
  </section>`;
}

function rosterHtml() {
  const label = { playing: 'In match', ready: 'Ready', waiting: 'In queue', joining: 'Choosing a name' };
  const rows = state.players.map((p) => `
    <li class="${p.id === state.me?.id ? 'you' : ''}">
      <span><strong>${esc(p.nickname ?? 'New player')}</strong> · ${p.score} pt${p.score === 1 ? '' : 's'}</span>
      <span class="pill ${p.status}">${label[p.status]}</span>
    </li>`).join('');
  return `<ul class="roster"><h2>${state.online} connected to the server</h2>${rows}</ul>`;
}

// Difficulty + streak-bonus picker. Only a seated player can change the mode; others see it read-only.
function modePanelHtml(editable) {
  const m = state.mode;
  if (!m) return '';
  const diffs = (m.difficulties ?? []).map((d) =>
    `<button class="pickbtn ${m.difficulty === d.key ? 'on' : ''}" data-act="setdiff" data-diff="${d.key}" ${editable ? '' : 'disabled'}>${esc(d.label)} <small>${d.seconds}s</small></button>`).join('');
  return `<div class="mode-panel">
    <div class="mode-row"><span class="mode-label">Difficulty</span><div class="picker">${diffs}</div></div>
    <div class="mode-row"><span class="mode-label">Win-streak bonus</span>
      <button class="pickbtn ${m.streakMode ? 'on' : ''}" data-act="togglestreak" ${editable ? '' : 'disabled'}>${m.streakMode ? 'On · consecutive wins score more' : 'Off · flat 1 point per win'}</button>
    </div>
  </div>`;
}

function leaderboardHtml() {
  if (!state.leaderboard?.length) return '';
  const rows = state.leaderboard.map((r, i) =>
    `<li><span class="rank">${i + 1}</span><span class="who ${r.name === state.me?.nickname ? 'you' : ''}">${esc(r.name)}</span><span class="w">${r.wins} win${r.wins === 1 ? '' : 's'}${r.bestStreak > 1 ? ` · 🔥${r.bestStreak}` : ''}</span></li>`).join('');
  return `<section class="board"><h2>🏆 All-time leaderboard</h2><ol class="lb">${rows}</ol></section>`;
}

function historyHtml() {
  if (!state.history?.length) return '';
  const rows = state.history.map((h) =>
    `<li><span class="hd">${h.digits.join(' ')} → <strong>${h.target}</strong></span>
       <span class="hr">${h.timedOut ? 'no winner' : `${esc(h.winner)}: ${esc(h.winningExpression)}`}</span></li>`).join('');
  return `<section class="board"><h2>🕑 Recent matches</h2><ul class="hist">${rows}</ul></section>`;
}

function viewLobby() {
  const me = state.players.find((p) => p.id === state.me?.id);
  const opps = state.players.filter((p) => p.id !== state.me?.id && (p.status === 'ready' || p.status === 'playing'));
  const opp = opps[0];
  const seated = me?.status === 'ready';
  let line = 'Choose how you want to play.';
  const botPlayer = botSeated() && state.players.find((p) => !p.isBot && p.status === 'playing');
  if (me?.status === 'waiting' && botPlayer) line = `${esc(botPlayer.nickname)} is playing the AI bot. They've been asked to let you in…`;
  else if (me?.status === 'waiting') line = "A round is in progress. You'll race in the next one.";
  else if (opps.length) line = `${opps.length + 1} players: you vs ${names(opps)}. Starting soon…`;
  return `${topbar()}${waitingStripHtml()}
    <h2 class="welcome">Welcome, ${esc(state.me.nickname)}.</h2>
    <p class="status-line">${line}</p>
    ${chooserHtml(seated && !opp)}
    ${seated ? modePanelHtml(true) : ''}
    ${rosterHtml()}
    ${leaderboardHtml()}
    ${historyHtml()}`;
}

// Start menu: pick your opponent. Shown when you hold a seat and nobody else is in the match yet.
function chooserHtml(show) {
  if (!show) return '';
  return `<div class="chooser">
    <h3 class="choose-h">What do you want to do?</h3>
    <div class="choose-cards">
      <article class="choice">
        <div class="ico">🧑‍🤝‍🧑</div>
        <h4>Play people</h4>
        <p>Everyone who joins races together. The match starts the moment someone else joins.</p>
        <div class="waitdots">Waiting for an opponent…</div>
      </article>
      <article class="choice bot">
        <div class="ico">🤖</div>
        <h4>Play the AI bot</h4>
        <p>Race a Groq-powered opponent right now, and watch it solve. Pick its skill:</p>
        <div class="bot-btns">
          <button class="ghost" data-act="addbot" data-diff="easy">Easy</button>
          <button class="ghost" data-act="addbot" data-diff="medium">Medium</button>
          <button class="primary" data-act="addbot" data-diff="hard">Hard</button>
        </div>
      </article>
    </div>
  </div>`;
}

function opponents() {
  return state.players.filter((p) => p.status === 'playing' && p.id !== state.me?.id);
}

function viewReady() {
  const opps = opponents();
  return `${topbar()}
    <h2 class="welcome">${esc(state.me.nickname)} vs ${opps.length ? names(opps) : '…'}</h2>
    <p class="status-line">${state.paused ? 'Paused. Someone new wants to race.' : 'Get ready. New digits and a new target are coming.'}</p>
    <div class="countdown-big">3</div>`;
}

function scoreline() {
  const mine = state.players.find((p) => p.id === state.me.id);
  const opps = opponents();
  const right = opps.length === 1
    ? `<div class="p right"><span class="score">${opps[0].score}</span><span>${esc(opps[0].nickname)}</span></div>`
    : `<div class="p right opps">${opps.map((o) => `<span class="opp">${esc(o.nickname)} <b>${o.score}</b></span>`).join('') || '<span>—</span>'}</div>`;
  return `<div class="scoreline">
    <div class="p"><span>${esc(mine?.nickname)}</span><span class="score">${mine?.score ?? 0}</span></div>
    <div class="clock ${state.paused ? 'paused' : ''}" role="timer">00:01:00</div>
    ${right}
  </div>${state.paused ? '<p class="paused-note">⏸ Paused</p>' : ''}`;
}

// What the player sees of the AI opponent: a solving-progress bar and the token cost — never the
// actual steps (those are on the admin page), so the opponent's working is not revealed mid-match.
function botProgress(b) {
  if (state.screen !== 'match') return 100;          // match over: bot has finished
  if (!b.revealMs) return 100;
  return Math.min(100, Math.round(((Date.now() - b.startedAt) / b.revealMs) * 100));
}
function botBrainHtml() {
  const b = state.botThink;
  if (!b) return '';
  const pct = botProgress(b);
  const status = pct >= 100 ? 'Bot has an answer ready' : 'Bot is solving…';
  let tokenLine;
  if (b.source === 'llm') {
    const u = b.usage || {};
    const delta = b.delta == null ? 'first LLM round this game'
      : b.delta === 0 ? 'same as last round'
      : b.delta > 0 ? `▲ ${b.delta} more than last round` : `▼ ${-b.delta} fewer than last round`;
    tokenLine = `<div class="tok"><strong>${b.totalTokens}</strong> tokens — prompt ${u.promptTokens} + output ${u.completionTokens} · <span class="delta">${delta}</span></div>`;
  } else {
    tokenLine = '<div class="tok">Answered by the built-in solver · <strong>0</strong> tokens (no Groq key set)</div>';
  }
  const src = b.source === 'llm' ? `Groq${b.usage?.model ? ` · ${esc(b.usage.model)}` : ''}` : 'Exhaustive solver';
  return `<section class="botbrain">
    <h3>🤖 Bot brain <span class="src">${src}</span></h3>
    <div class="botbar"><div class="botfill" style="width:${pct}%"></div></div>
    <div class="botstatus"><span class="botlabel">${status}</span> <span class="botsteps">${b.totalSteps} step${b.totalSteps === 1 ? '' : 's'}</span></div>
    ${tokenLine}
  </section>`;
}

function viewMatch() {
  const { digits, target, maxHints } = state.match;
  const used = usedSlots();
  const pv = previewText();
  const fresh = Date.now() - (state.pushedAt ?? 0) < 150;
  const chips = state.tokens.map((t, n) => {
    const anim = fresh && n === state.tokens.length - 1 ? ' new' : '';
    return t.t === 'digit' ? `<span class="chip d${anim}">${digits[t.i]}</span>` : `<span class="chip o${anim}">${t.t === 'op' ? opLabel(t.v) : t.t === 'lp' ? '(' : ')'}</span>`;
  }).join('');
  return `${topbar()}${scoreline()}${waitingStripHtml()}
    <div class="board-area ${state.paused ? 'is-paused' : ''}">
    <div class="marquee"><div class="label">Make</div><div class="target">${target}</div></div>
    <div class="tiles">${digits.map((d, i) => `<button class="tile" data-digit="${i}" ${used.has(i) ? 'disabled' : ''} aria-label="Digit ${d}">${d}</button>`).join('')}</div>
    <div class="ops">
      ${OPS.map(([v, l]) => `<button class="op" data-op="${v}" aria-label="${v === 'x' ? 'times' : v === '/' ? 'divide' : v}">${l}</button>`).join('')}
      <button class="op" data-paren="lp">(</button><button class="op" data-paren="rp">)</button>
    </div>
    <div class="tray">
      <div class="expr">${chips || '<span class="placeholder">Tap the tiles to build your answer</span>'}</div>
      <div class="equals">= <b>${target}</b></div>
    </div>
    <div class="preview ${pv.hit ? 'hit' : ''}">${esc(pv.text)}</div>
    <div class="actions">
      <button class="ghost" data-act="undo" ${state.tokens.length ? '' : 'disabled'}>Undo</button>
      <button class="ghost" data-act="clear" ${state.tokens.length ? '' : 'disabled'}>Clear</button>
      <button class="ghost" data-act="hint" ${state.hints.length >= maxHints ? 'disabled' : ''}>Hint (${maxHints - state.hints.length} left)</button>
      <button class="primary grow" data-act="submit" ${state.tokens.length ? '' : 'disabled'}>Submit answer</button>
    </div>
    <div class="feedback ${state.feedback?.bad ? 'bad' : ''}">${esc(state.feedback?.text ?? '')}</div>
    ${state.hints.length ? `<ul class="hints">${state.hints.map((h) => `<li${h.ai ? ' class="ai"' : ''}>${esc(h.text)}</li>`).join('')}</ul>` : ''}
    </div>
    ${botBrainHtml()}`;
}

function viewEnd() {
  const e = state.end;
  const win = e.result === 'win';
  let detail;
  if (e.reason === 'timeout') detail = `Time's up. Nobody reached <strong>${e.target}</strong>, so no point this round.`;
  else if (win) detail = `You solved it first: <strong>${esc(e.winningExpression)} = ${e.target}</strong>`;
  else detail = `${esc(e.winner)} got there first with <strong>${esc(e.winningExpression)} = ${e.target}</strong>`;
  const iq = state.iq
    ? `<div class="iq">${state.iq.reports.map((r) => `<article><div class="who">${esc(r.name)}'s match IQ</div><div class="num">${r.iq}</div><p class="roast">${esc(r.roast)}</p></article>`).join('')}</div>
       <p class="iq-note">${state.iq.source === 'ai' ? 'Estimated by an AI model from attempts, hints and solve time. Purely for fun.' : 'Estimated from attempts, hints and solve time. Purely for fun.'}</p>`
    : `<p class="iq-note" style="margin-top:0">Measuring brains…</p>`;
  const iVoted = state.votes.includes(state.me.nickname);
  const others = state.votes.filter((n) => n !== state.me.nickname);
  const streakLine = win && e.streakMode && e.streak > 1
    ? `<p class="streak-badge">🔥 ${e.streak} win streak — worth ${e.pointsAwarded} points!</p>` : '';
  const seated = state.players.find((p) => p.id === state.me?.id)?.status === 'ready';
  return `${topbar()}${waitingStripHtml()}
    <section class="verdict ${win ? 'win' : 'lost'}">
      <div class="word">${win ? 'Win' : 'Lost'}</div>
      <p>${detail}</p>
      ${streakLine}
      <p>One key solution: <strong>${esc(e.keySolution)} = ${e.target}</strong></p>
    </section>
    <div class="final-scores">${e.scores.map((s) => `<div><span class="score">${s.score}</span>${esc(s.nickname)}</div>`).join('')}</div>
    ${botBrainHtml()}
    ${iq}
    <div class="center">
      <button class="primary" data-act="rematch" ${iVoted ? 'disabled' : ''}>${iVoted ? `Waiting for others (${state.votes.length}/${e.scores.length})` : 'Rematch'}</button>
      ${state.players.some((p) => p.isBot) ? '<button class="ghost" data-act="removebot">Back to menu</button>' : ''}
      <div class="votes">${others.length ? `${esc(others.join(', '))} wants a rematch.` : ''}</div>
    </div>
    ${seated ? `<p class="mode-hint">Mode for the rematch:</p>${modePanelHtml(true)}` : ''}
    ${leaderboardHtml()}
    ${historyHtml()}`;
}

const views = { connecting: viewConnecting, nickname: viewNickname, lobby: viewLobby, ready: viewReady, match: viewMatch, end: viewEnd };

function render() {
  app.innerHTML = views[state.screen]() + inviteHtml() + (state.banner ? `<div class="banner" role="status">${esc(state.banner)}</div>` : '');
  if (state.screen === 'match' || state.screen === 'ready') tickClock();
  document.getElementById('nick')?.focus();
}
// Same as render, but keeps keyboard focus on the button that was pressed.
function renderSoft() {
  const sel = document.activeElement?.dataset && Object.entries(document.activeElement.dataset)[0];
  render();
  if (sel) document.querySelector(`[data-${sel[0]}="${sel[1]}"]:not(:disabled)`)?.focus();
}

// ---------- input ----------

app.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'join') return;
  ev.preventDefault();
  const nickname = ev.target.nick.value.trim();
  if (!nickname) { state.joinError = 'Please enter a nickname'; return render(); }
  socket.emit('join', { nickname });
});

app.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || b.disabled) return;
  const { digit, op, paren, act } = b.dataset;
  if (digit !== undefined) push({ t: 'digit', i: Number(digit) });
  else if (op) push({ t: 'op', v: op });
  else if (paren) push({ t: paren });
  else if (act === 'undo') undo();
  else if (act === 'clear') clearExpr();
  else if (act === 'submit') submit();
  else if (act === 'hint') socket.emit('hint');
  else if (act === 'rematch') socket.emit('rematch');
  else if (act === 'addbot') socket.emit('add_bot', { difficulty: b.dataset.diff });
  else if (act === 'removebot') socket.emit('remove_bot');
  else if (act === 'joinhumans') { state.invite = null; socket.emit('bot_choice', { choice: 'humans' }); render(); }
  else if (act === 'keepbot') { state.invite = null; socket.emit('bot_choice', { choice: 'bot' }); render(); }
  else if (act === 'mute') { setMuted(!state.muted); state.muted = !state.muted; if (!state.muted) sfx.tap(); render(); }
  else if (act === 'theme') cycleTheme();
  else if (act === 'setdiff') socket.emit('set_mode', { difficulty: b.dataset.diff });
  else if (act === 'togglestreak') socket.emit('set_mode', { streakMode: !state.mode?.streakMode });
});

document.addEventListener('keydown', (ev) => {
  if (state.screen !== 'match' || ev.metaKey || ev.ctrlKey) return;
  const k = ev.key;
  if (/^[0-9]$/.test(k)) pressDigitKey(Number(k));
  else if (k === '+' || k === '-') push({ t: 'op', v: k });
  else if (k === '*' || k === 'x' || k === 'X') push({ t: 'op', v: 'x' });
  else if (k === '/') { ev.preventDefault(); push({ t: 'op', v: '/' }); }
  else if (k === '(') push({ t: 'lp' });
  else if (k === ')') push({ t: 'rp' });
  else if (k === 'Backspace') undo();
  else if (k === 'Escape') clearExpr();
  else if (k === 'Enter') { ev.preventDefault(); submit(); }
  else return;
});

boot();
