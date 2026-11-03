// IQ180 server: Express serves the built client and /admin; socket.io carries all game traffic.
import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Server } from 'socket.io';
import { Game } from './game.js';
import { PORT } from './config.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CLIENT_DIST = here('../client/dist');

// A tunnel (ngrok) connects to us from 127.0.0.1, so "is loopback" alone is not enough:
// tunnelled requests also carry forwarding headers, real local ones do not.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'ngrok-trace-id', 'cf-connecting-ip'];
export const isLocalAdmin = (address, headers = {}) =>
  LOOPBACK.has(address) && !FORWARD_HEADERS.some((h) => headers[h]);

export function startServer({ port = PORT, quiet = false } = {}) {
  const app = express();
  const http = createServer(app);
  const io = new Server(http, {
    cors: { origin: true, allowedHeaders: ['ngrok-skip-browser-warning'] },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 16_000,
  });

  const admin = io.of('/admin');
  admin.use((socket, next) =>
    isLocalAdmin(socket.handshake.address, socket.handshake.headers) ? next() : next(new Error('Admin is only available on the server computer')));

  const game = new Game(io, {
    onChange: (state) => {
      admin.emit('admin_state', state);
      if (!quiet) printStatus(state);
    },
  });

  io.on('connection', (socket) => {
    game.connect(socket);
    socket.on('join', (p) => game.join(socket, p?.nickname));
    socket.on('submit', (p) => game.submit(socket, p?.tokens));
    socket.on('hint', () => game.hint(socket));
    socket.on('rematch', () => game.rematch(socket));
    socket.on('add_bot', (p) => game.addBot(socket, p?.difficulty));
    socket.on('remove_bot', () => game.requestRemoveBot(socket));
    socket.on('set_mode', (p) => game.setMode(socket, p));
    socket.on('disconnect', () => game.disconnect(socket));
  });

  admin.on('connection', (socket) => {
    socket.emit('admin_state', game.adminState());
    socket.on('admin_reset', () => {
      if (!quiet) console.log('\n[admin] RESET pressed: scores cleared, back to lobby');
      game.reset();
    });
  });

  app.get(['/admin', '/admin/'], (req, res, next) =>
    isLocalAdmin(req.socket.remoteAddress, req.headers) ? next() : res.status(403).send('Admin page is only available on the server computer.'));
  app.use('/admin', (req, res, next) =>
    isLocalAdmin(req.socket.remoteAddress, req.headers) ? next() : res.sendStatus(403), express.static(here('./admin')));

  if (existsSync(CLIENT_DIST)) app.use(express.static(CLIENT_DIST));
  else app.get('/', (_req, res) => res.send('Client not built yet. Run <code>npm run build</code>.'));

  return new Promise((resolve) => {
    http.listen(port, () => {
      const actual = http.address().port;
      if (!quiet) printBanner(actual);
      resolve({ io, game, http, port: actual, close: () => new Promise((r) => { io.close(); http.close(() => r()); }) });
    });
  });
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function printBanner(port) {
  console.log('\n  IQ180 server is running');
  console.log(`  Game (this computer):   http://localhost:${port}`);
  console.log(`  Admin (this computer):  http://localhost:${port}/admin`);
  for (const ip of lanAddresses()) console.log(`  LAN fallback:           http://${ip}:${port}`);
  console.log('  Public: start the tunnel with `npm run tunnel` in another terminal\n');
}

// The brief asks the *server program* to display these; /admin shows them too.
let lastLine = '';
function printStatus(s) {
  const names = s.players.map((p) => `${p.nickname ?? '(joining)'}[${p.score}${p.status === 'playing' ? ', playing' : p.status === 'waiting' ? ', queued' : ''}]`);
  const key = s.match ? `match #${s.matchNo}: ${s.match.digits.join(' ')} -> ${s.match.target} | key: ${s.match.keySolution} = ${s.match.target}` : 'no match';
  const line = `[status] online: ${s.online} | clients: ${names.join(', ') || '-'} | phase: ${s.phase} | ${key}`;
  if (line !== lastLine) console.log(line);
  lastLine = line;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
