// End-to-end over real sockets: two (or three) clients against a server on a random port.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';

process.env.MATCH_MS = '1500';
process.env.GET_READY_MS = '50';
process.env.BOT_PROMPT_MS = '700';
// keep tests offline: empty values block server/.env from enabling the LLM, so the IQ roast uses the formula
process.env.LLM_API_KEY = process.env.GROQ_API_KEY = process.env.LLM_BASE_URL = '';

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
  await once(B, 'welcome');
  assert.equal(srv.game.phase, 'lobby', 'two humans must not be forced into a match');
  A.emit('play_people'); B.emit('play_people');
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
  A.emit('play_people'); C.emit('play_people'); // Cleo takes the free seat; both opt in
  await cStarts;
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

test('hints are private, capped at MAX_HINTS, and fall back to solver wording offline', async () => {
  const { A, B } = await pair();
  const seenByB = [];
  B.onAny((ev) => seenByB.push(ev));
  A.emit('hint');
  const h1 = await once(A, 'hint');
  A.emit('hint');
  const h2 = await once(A, 'hint');
  A.emit('hint');
  const h3 = await once(A, 'hint');
  assert.ok(h1.text && h2.text && h1.text !== h2.text);
  assert.equal(h1.source, 'solver');
  assert.equal(h2.used, 2);
  assert.equal(h3.text, null);
  assert.ok(!seenByB.includes('hint'), 'B must not see A’s hints');
  close(A, B);
});

// ---------- AI opponent ----------

const { Bot } = await import('../server/bot.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function soloVsBot(name = 'Solo') {
  const A = client();
  const welcomeA = once(A, 'welcome');
  A.emit('join', { nickname: name });
  await welcomeA;
  const startA = once(A, 'match_start');
  A.emit('add_bot', { difficulty: 'easy' });
  return { A, m: await startA };
}

test('bot: a human arriving pauses the bot match; "join the challenge" starts a fresh human match', async () => {
  const { A } = await soloVsBot();
  assert.ok(srv.game.bot, 'bot seated');
  const B = client();
  const appeared = once(A, 'opponent_appeared');
  B.emit('join', { nickname: 'Waiter' });
  const offer = await appeared;
  assert.deepEqual(offer.names, ['Waiter']);
  assert.ok(srv.game.paused, 'match paused');
  B.emit('bot_choice', { choice: 'humans' });  // queued player: must be ignored
  B.emit('remove_bot');
  await wait(100);
  assert.ok(srv.game.bot, 'queued player cannot remove the bot');

  const aborted = once(A, 'match_aborted'), nextA = once(A, 'match_start'), nextB = once(B, 'match_start');
  A.emit('bot_choice', { choice: 'humans' });
  assert.match((await aborted).reason, /human challenge/);
  const [mA, mB] = await Promise.all([nextA, nextB]);
  assert.equal(srv.game.bot, null);
  assert.equal(mA.target, mB.target);
  close(A, B);
});

test('bot: "continue with bot" resumes with the paused time; switching later still works', async () => {
  const { A } = await soloVsBot();
  const B = client();
  const appeared = once(A, 'opponent_appeared');
  B.emit('join', { nickname: 'Patient' });
  await appeared;
  const left = srv.game.paused.remainingMs;
  await wait(300);                               // time spent paused must not count
  const resumed = once(A, 'match_resumed');
  A.emit('bot_choice', { choice: 'bot' });
  const r = await resumed;
  assert.ok(r.endsAt - r.serverNow >= left - 50, 'clock resumes where it paused');
  assert.equal(srv.game.paused, null);
  assert.ok(srv.game.keepBot);
  assert.ok(srv.game.queue.length === 1, 'newcomer still waiting');

  const nextB = once(B, 'match_start');
  A.emit('bot_choice', { choice: 'humans' });   // the light banner's "Play with players"
  await nextB;
  assert.equal(srv.game.bot, null);
  close(A, B);
});

test('bot: can still be picked when other people are in the lobby; they wait, no pop-up', async () => {
  const A = client(), B = client();
  const wa = once(A, 'welcome');
  A.emit('join', { nickname: 'Picky' });
  await wa;
  const wb = once(B, 'welcome');
  B.emit('join', { nickname: 'Other' });
  await wb;
  B.emit('play_people');
  const seenByA = [];
  A.onAny((ev) => seenByA.push(ev));
  const startA = once(A, 'match_start');
  A.emit('add_bot', { difficulty: 'easy' });
  await startA;
  assert.ok(srv.game.bot, 'bot seated');
  assert.equal(srv.game.seats.length, 2, 'just the player and the bot');
  assert.deepEqual(srv.game.waitingHumans().map((c) => c.nickname), ['Other']);
  assert.ok(srv.game.keepBot && !srv.game.paused, 'match runs without pausing');
  assert.ok(!seenByA.includes('opponent_appeared'), 'no pop-up for someone already known');

  const nextB = once(B, 'match_start');
  A.emit('bot_choice', { choice: 'humans' });    // switch to the waiting player later
  await nextB;
  assert.equal(srv.game.bot, null);
  close(A, B);
});

test('bot: an ignored prompt continues with the bot on its own', async () => {
  const { A } = await soloVsBot();
  const B = client();
  const resumed = once(A, 'match_resumed', 3000);
  B.emit('join', { nickname: 'Ignored' });
  await resumed;
  assert.ok(srv.game.bot && srv.game.keepBot && !srv.game.paused);
  close(A, B);
});

test('everyone races together: 3 players, one winner; a mid-match joiner plays the next round', async () => {
  const { A, B, mA } = await pair('Ann', 'Ben');
  const C = client();
  const wc = once(C, 'welcome');
  C.emit('join', { nickname: 'Cat' });
  await wc;
  assert.equal(srv.game.queue.length, 1, 'mid-match joiner waits for the next round');
  const ends = [once(A, 'match_end'), once(B, 'match_end')];
  A.emit('submit', { tokens: answerFor(mA) });
  const [eA, eB] = await Promise.all(ends);
  assert.equal(eA.result, 'win');
  assert.equal(eB.result, 'lost');

  const starts = [once(A, 'match_start'), once(B, 'match_start'), once(C, 'match_start')];
  A.emit('rematch'); B.emit('rematch');
  const ms = await Promise.all(starts);
  assert.equal(srv.game.seats.length, 3);
  assert.ok(ms.every((m) => m.target === ms[0].target));

  // One of three leaves mid-match: the other two keep racing.
  const endC = once(C, 'match_end');
  B.close();
  await wait(100);
  assert.equal(srv.game.phase, 'playing');
  A.emit('submit', { tokens: answerFor(ms[0]) });
  assert.equal((await endC).result, 'lost');
  close(A, C);
});

test('bot: leaves with its human instead of being handed to the next player', async () => {
  const A = client();
  const welcomeA = once(A, 'welcome');
  A.emit('join', { nickname: 'Leaver' });
  await welcomeA;
  const startA = once(A, 'match_start');
  A.emit('add_bot', { difficulty: 'hard' });
  await startA;
  A.close();
  await wait(150);
  assert.equal(srv.game.bot, null);

  const C = client();
  const welcomeC = once(C, 'welcome');
  C.emit('join', { nickname: 'Newcomer' });
  await welcomeC;
  await wait(150);
  assert.equal(srv.game.phase, 'lobby', 'newcomer must not be dropped into a bot match');
  close(C);
});

test('bot: a slow LLM answer for an old match is never played into a newer one', async () => {
  const tree = [...solveAll([1, 2, 3, 4, 5]).values()][0][0];
  const submits = [];
  const game = { bot: null, phase: 'playing', matchNo: 1, puzzle: { solutions: [tree] }, submit: (...a) => submits.push(a), botThink() {} };
  const bot = new Bot(game, 'hard');
  game.bot = bot;

  const stale = bot.play({ matchNo: 1, digits: [1, 2, 3, 4, 5], target: 1, endsAt: Date.now() + 60_000 });
  game.matchNo = 2;                           // a rematch started while the answer was in flight
  await stale;
  assert.equal(bot.timer, null, 'stale answer must not be scheduled');

  await bot.play({ matchNo: 2, digits: [1, 2, 3, 4, 5], target: 1, endsAt: Date.now() + 60_000 });
  assert.ok(bot.timer, 'live answer is scheduled');
  bot.cancel();
  assert.equal(submits.length, 0);
});

test('surrender: vs a person ends the match for the other and sends the surrenderer home', async () => {
  const { A, B } = await pair('Quit', 'Stay');
  const home = once(A, 'surrendered');
  const aborted = once(B, 'match_aborted');
  A.emit('surrender');
  await home;
  assert.match((await aborted).reason, /Quit surrendered/);
  assert.equal(srv.game.phase, 'lobby');
  close(A, B);
});

test('surrender: vs the bot ends the match and removes the bot', async () => {
  const { A } = await soloVsBot('Giver');
  const home = once(A, 'surrendered');
  A.emit('surrender');
  await home;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(srv.game.bot, null);
  assert.equal(srv.game.phase, 'lobby');
  close(A);
});
