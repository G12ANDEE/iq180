// End-to-end over real sockets: two (or three) clients against a server on a random port.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';

process.env.MATCH_MS = '1500';
process.env.GET_READY_MS = '50';
delete process.env.ANTHROPIC_API_KEY; // keep tests offline: IQ roast uses the formula fallback

const { startServer, isLocalAdmin } = await import('../server/index.js');
const { solveAll, treeToTokens } = await import('../shared/solver.js');

let srv, url;
before(async () => { srv = await startServer({ port: 0, quiet: true }); url = `http://localhost:${srv.port}`; });
after(async () => { srv.io.disconnectSockets(true); await srv.close(); });

const client = () => { const s = connect(url, { transports: ['websocket'], forceNew: true }); open.add(s); return s; };
const once = (s, ev, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});
const answerFor = ({ digits, target }) => treeToTokens(solveAll(digits).get(target)[0]);
const wrongFor = (digits) => digits.flatMap((_, i) => (i ? [{ t: 'op', v: '+' }, { t: 'digit', i }] : [{ t: 'digit', i }]));

async function pair(a = 'Alice', b = 'Bob') {
  const A = client(), B = client();
  const startA = once(A, 'match_start'), startB = once(B, 'match_start');
  const welcomeA = once(A, 'welcome');
  A.emit('join', { nickname: a });
  const w = await welcomeA;
  B.emit('join', { nickname: b });
  return { A, B, welcome: w, mA: await startA, mB: await startB };
}
const open = new Set();
const close = (...ss) => ss.forEach((s) => s.close());
afterEach(async () => { for (const s of open) s.close(); open.clear(); await new Promise((r) => setTimeout(r, 100)); });

test('join, welcome, player list, same puzzle for both, server-driven timer', async () => {
  const { A, B, welcome, mA, mB } = await pair();
  assert.equal(welcome.nickname, 'Alice');
  assert.deepEqual(mA.digits, mB.digits);
  assert.equal(mA.target, mB.target);
  assert.equal(mA.digits.length, 5);
  assert.ok(mA.endsAt - mA.serverNow <= 1500 && mA.endsAt > mA.serverNow);
  assert.equal(srv.game.adminState().online, 2);
  assert.ok(srv.game.adminState().match.keySolution);
  close(A, B);
});

test('wrong answer rejected privately; correct answer wins; opponent never sees attempts', async () => {
  const { A, B, mA } = await pair();
  const seenByB = [];
  B.onAny((ev) => seenByB.push(ev));
  A.emit('submit', { tokens: wrongFor(mA.digits) });
  const rej = await once(A, 'submit_rejected');
  assert.ok(rej.reason);
  const endA = once(A, 'match_end'), endB = once(B, 'match_end'), iqB = once(B, 'iq_report');
  A.emit('submit', { tokens: answerFor(mA) });
  const [ea, eb] = await Promise.all([endA, endB]);
  assert.equal(ea.result, 'win');
  assert.equal(eb.result, 'lost');
  assert.equal(ea.scores.find((s) => s.nickname === 'Alice').score, 1);
  assert.ok(!seenByB.includes('submit_rejected'), 'B must not learn about A’s wrong attempt');
  const iq = await iqB;
  assert.equal(iq.reports.length, 2);
  close(A, B);
});

test('two simultaneous correct submissions produce exactly one winner; late submit ignored', async () => {
  const { A, B, mA } = await pair();
  const endA = once(A, 'match_end'), endB = once(B, 'match_end');
  const rejected = Promise.race([once(A, 'submit_rejected'), once(B, 'submit_rejected')]);
  const tokens = answerFor(mA);
  A.emit('submit', { tokens });
  B.emit('submit', { tokens });
  const [ea, eb] = await Promise.all([endA, endB]);
  assert.equal([ea.result, eb.result].filter((r) => r === 'win').length, 1);
  assert.match((await rejected).reason, /No match/);
  assert.equal(ea.scores.reduce((n, s) => n + s.score, 0), 1);
  close(A, B);
});

test('timeout ends match with no point; rematch needs both votes and deals a new key', async () => {
  const { A, B } = await pair();
  const [ea] = await Promise.all([once(A, 'match_end', 3000), once(B, 'match_end', 3000)]);
  assert.equal(ea.reason, 'timeout');
  assert.equal(ea.result, 'lost');
  assert.ok(ea.scores.every((s) => s.score === 0));
  const matchNo = srv.game.matchNo;
  A.emit('rematch');
  const st = await once(B, 'rematch_status');
  assert.deepEqual(st.votes, ['Alice']);
  assert.equal(srv.game.phase, 'finished', 'one vote must not start a rematch');
  const next = once(A, 'match_start');
  B.emit('rematch');
  await next;
  assert.equal(srv.game.matchNo, matchNo + 1);
  close(A, B);
});

test('duplicate nickname gets a suffix; third client queues; disconnect mid-match promotes the queue', async () => {
  const { A, B } = await pair('Sam', 'Sam');
  const C = client();
  const wc = once(C, 'welcome');
  C.emit('join', { nickname: 'Cleo' });
  const w = await wc;
  assert.equal(w.players.find((p) => p.nickname === 'Cleo').status, 'waiting');
  assert.ok(w.players.some((p) => p.nickname === 'Sam (2)'));
  const aborted = once(A, 'match_aborted');
  const cStarts = once(C, 'match_start');
  B.close();
  assert.match((await aborted).reason, /left/);
  await cStarts; // Cleo takes the free seat and a fresh match starts
  close(A, C);
});

test('admin reset clears scores and notifies clients; admin is blocked through a tunnel', async () => {
  const { A, B, mA } = await pair();
  const endA = once(A, 'match_end');
  A.emit('submit', { tokens: answerFor(mA) });
  await endA;
  const adminSock = connect(`${url}/admin`, { transports: ['websocket'], forceNew: true });
  await once(adminSock, 'admin_state');
  const resetA = once(A, 'reset');
  adminSock.emit('admin_reset');
  await resetA;
  assert.ok(srv.game.adminState().players.every((p) => p.score === 0));
  assert.equal(isLocalAdmin('127.0.0.1', {}), true);
  assert.equal(isLocalAdmin('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), false);
  assert.equal(isLocalAdmin('192.168.1.50', {}), false);
  close(A, B, adminSock);
});
