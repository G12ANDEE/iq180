// Server display: online count, connected clients, key solution, and the reset button.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const socket = io('/admin', { transports: ['websocket', 'polling'] });
let state = null;
let offset = 0;

socket.on('connect', () => { $('conn').textContent = 'Live'; });
socket.on('disconnect', () => { $('conn').textContent = 'Disconnected from server. Retrying…'; });
socket.on('connect_error', (e) => { $('conn').textContent = e.message; });
socket.on('admin_state', (s) => { state = s; offset = s.serverNow - Date.now(); render(); });

const phaseText = { lobby: 'Waiting in lobby', ready: 'Get-ready countdown', playing: 'Match in progress', finished: 'Match finished' };
const statusText = { playing: 'In match', ready: 'Seated', waiting: 'In queue', joining: 'Choosing a name' };

function render() {
  $('online').textContent = state.online;
  $('clients').innerHTML = state.players.map((p) =>
    `<tr><td>${esc(p.nickname ?? '(no nickname yet)')}</td><td>${p.score}</td><td>${statusText[p.status]}</td></tr>`).join('')
    || '<tr><td colspan="3">No clients connected</td></tr>';

  if (state.mode) {
    const d = (state.mode.difficulties ?? []).find((x) => x.key === state.mode.difficulty);
    $('mode').textContent = `Mode: difficulty ${d?.label ?? state.mode.difficulty} (${d?.seconds ?? '?'}s) · win-streak bonus ${state.mode.streakMode ? 'ON' : 'off'}`;
  }

  const bt = state.botThink;
  if (!bt) {
    $('botbrain').textContent = 'No AI opponent solving this match.';
  } else {
    const src = bt.source === 'llm' ? `Groq${bt.usage?.model ? ` · ${esc(bt.usage.model)}` : ''} · ${bt.totalTokens} tokens (prompt ${bt.usage?.promptTokens ?? 0} + output ${bt.usage?.completionTokens ?? 0})` : 'Built-in solver · 0 tokens (no Groq key)';
    $('botbrain').innerHTML = `
      <div class="bb-src">${src}</div>
      <div class="bb-expr">${esc(bt.expression)}</div>
      <ol class="bb-steps">${bt.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
  }

  $('history').innerHTML = (state.history ?? []).map((h) =>
    `<li><span>${h.digits.join(' ')} → <strong>${h.target}</strong> <em>(${esc(h.difficulty)})</em></span>
       <span>${h.timedOut ? 'no winner' : `${esc(h.winner)}: ${esc(h.winningExpression)}`}</span></li>`).join('')
    || '<li>No matches played yet</li>';

  const m = state.match;
  if (!m) { $('match').textContent = 'No match yet. It starts when two players have joined.'; return; }
  let meta = `Match #${state.matchNo} · ${phaseText[state.phase]}`;
  if (state.phase === 'finished') meta += state.winner ? ` · ${esc(state.winner)} won` : ' · nobody solved it';
  if (state.rematchVotes.length) meta += ` · rematch votes: ${esc(state.rematchVotes.join(', '))}`;
  $('match').innerHTML = `
    <div class="digits">${m.digits.map((d) => `<span>${d}</span>`).join('')} → <strong>${m.target}</strong></div>
    <h2 style="margin-top:16px">Key solution</h2>
    <div class="solution">${esc(m.keySolution)} = ${m.target}</div>
    ${m.altSolutions.length > 1 ? `<h2>Other solutions</h2><ul class="alts">${m.altSolutions.filter((s) => s !== m.keySolution).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    <div class="meta">${meta} <span id="left"></span></div>`;
}

setInterval(() => {
  const el = $('left');
  if (el && state?.phase === 'playing') el.textContent = `· ${Math.max(0, Math.ceil((state.endsAt - (Date.now() + offset)) / 1000))}s left`;
}, 250);

$('reset').addEventListener('click', () => {
  if (confirm('Reset the current game and set every player\'s score to 0?')) socket.emit('admin_reset');
});
