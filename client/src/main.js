// IQ180 client: a view of server state. It never decides correctness or time; it only renders
// what the server says and sends intents (join, submit, hint, rematch).
import './style.css';
import { connectToServer } from './net.js';
import { evaluate, checkTokens } from '../../shared/expr.js';

const app = document.getElementById('app');
const OPS = [['+', '+'], ['-', '−'], ['x', '×'], ['/', '÷']];

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
};

let socket;
let clockTimer;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opLabel = (v) => OPS.find(([k]) => k === v)?.[1] ?? v;
const serverNow = () => Date.now() + (state.match?.offset ?? 0);

// ---------- connection & server events ----------

async function boot() {
  render();
  const conn = await connectToServer((url) => { state.server = url; render(); });
  socket = conn.socket;
  state.server = conn.url;
  state.screen = 'nickname';
  render();

  socket.on('players_update', (p) => { Object.assign(state, { players: p.players, queue: p.queue, online: p.online }); if (['lobby', 'match', 'end', 'ready'].includes(state.screen)) renderSoft(); });
  socket.on('join_error', ({ reason }) => { state.joinError = reason; render(); });
  socket.on('welcome', (p) => {
    state.me = { id: p.id, nickname: p.nickname };
    Object.assign(state, { players: p.players, queue: p.queue, online: p.online, screen: 'lobby', joinError: '' });
    render();
  });
  socket.on('get_ready', ({ startsAt, serverNow: sn }) => {
    state.readyAt = Date.now() + (startsAt - sn);
    Object.assign(state, { screen: 'ready', end: null, iq: null, votes: [] });
    render();
    tickClock();
  });
  socket.on('match_start', (m) => {
    state.match = { ...m, offset: m.serverNow - Date.now() };
    Object.assign(state, { screen: 'match', tokens: [], hints: [], feedback: null, end: null, iq: null, votes: [] });
    render();
    tickClock();
  });
  socket.on('submit_rejected', ({ reason }) => { if (state.screen === 'match') { state.feedback = { text: reason, bad: true }; renderSoft(); } });
  socket.on('hint', ({ text }) => { if (text) state.hints.push(text); else state.feedback = { text: 'No hints left this round', bad: true }; render(); });
  socket.on('match_end', (e) => { state.end = e; state.screen = 'end'; render(); });
  socket.on('iq_report', (r) => { if (r.matchNo === state.end?.matchNo) { state.iq = r; render(); } });
  socket.on('rematch_status', ({ votes }) => { state.votes = votes; render(); });
  socket.on('match_aborted', ({ reason }) => { flash(`${reason}. Back to the lobby.`); state.screen = 'lobby'; state.match = null; render(); });
  socket.on('reset', ({ message }) => { flash(message); state.screen = 'lobby'; state.match = null; state.end = null; render(); });
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
  if (state.screen !== 'match') return;
  if (tok.t === 'digit' && usedSlots().has(tok.i)) return;
  state.tokens.push(tok);
  state.pushedAt = Date.now();
  state.feedback = null;
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
  if (!state.tokens.length) return;
  socket.emit('submit', { tokens: state.tokens });
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
      const ms = Math.max(0, state.match.endsAt - serverNow());
      const el = document.querySelector('.clock');
      if (el) {
        const s = Math.ceil(ms / 1000);
        el.textContent = `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        el.classList.toggle('low', s <= 10);
      }
    } else clearInterval(clockTimer);
  };
  update();
  clockTimer = setInterval(update, 200);
}

// ---------- views ----------

const topbar = () => `
  <header class="topbar">
    <h1 class="brand">IQ180</h1>
    ${state.me ? `<div class="me">Playing as <strong>${esc(state.me.nickname)}</strong> · score <strong>${myScore()}</strong></div>` : ''}
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

function viewLobby() {
  const me = state.players.find((p) => p.id === state.me?.id);
  const named = state.players.filter((p) => p.nickname).length;
  let line = 'Waiting for an opponent to join…';
  if (me?.status === 'waiting') line = `A match is in progress. You're number ${state.queue.indexOf(state.me.nickname) + 1} in the queue.`;
  else if (named >= 2 && me?.status === 'ready') line = 'Opponent found. Starting soon…';
  return `${topbar()}
    <h2 class="welcome">Welcome, ${esc(state.me.nickname)}.</h2>
    <p class="status-line">${line}</p>
    ${rosterHtml()}`;
}

function opponent() {
  return state.players.find((p) => p.status === 'playing' && p.id !== state.me?.id);
}

function viewReady() {
  const opp = opponent();
  return `${topbar()}
    <h2 class="welcome">${esc(state.me.nickname)} vs ${esc(opp?.nickname ?? '…')}</h2>
    <p class="status-line">Get ready. New digits and a new target are coming.</p>
    <div class="countdown-big">3</div>`;
}

function scoreline() {
  const mine = state.players.find((p) => p.id === state.me.id);
  const opp = opponent() ?? state.players.find((p) => p.id !== state.me.id && p.status !== 'waiting');
  return `<div class="scoreline">
    <div class="p"><span>${esc(mine?.nickname)}</span><span class="score">${mine?.score ?? 0}</span></div>
    <div class="clock" role="timer">00:01:00</div>
    <div class="p right"><span class="score">${opp?.score ?? 0}</span><span>${esc(opp?.nickname ?? '—')}</span></div>
  </div>`;
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
  return `${topbar()}${scoreline()}
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
    ${state.hints.length ? `<ul class="hints">${state.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}`;
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
  return `${topbar()}
    <section class="verdict ${win ? 'win' : 'lost'}">
      <div class="word">${win ? 'Win' : 'Lost'}</div>
      <p>${detail}</p>
      <p>One key solution: <strong>${esc(e.keySolution)} = ${e.target}</strong></p>
    </section>
    <div class="final-scores">${e.scores.map((s) => `<div><span class="score">${s.score}</span>${esc(s.nickname)}</div>`).join('')}</div>
    ${iq}
    <div class="center">
      <button class="primary" data-act="rematch" ${iVoted ? 'disabled' : ''}>${iVoted ? 'Waiting for opponent…' : 'Rematch'}</button>
      <div class="votes">${others.length ? `${esc(others.join(', '))} wants a rematch.` : ''}</div>
    </div>`;
}

const views = { connecting: viewConnecting, nickname: viewNickname, lobby: viewLobby, ready: viewReady, match: viewMatch, end: viewEnd };

function render() {
  app.innerHTML = views[state.screen]() + (state.banner ? `<div class="banner" role="status">${esc(state.banner)}</div>` : '');
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
