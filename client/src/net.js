import { io } from 'socket.io-client';
import { SERVER_URL, LAN_FALLBACK_URL, CONNECT_TIMEOUT_MS } from './config.js';

const isPlaceholder = (u) => !u || u.includes('YOUR-STATIC-DOMAIN');

export function candidateUrls() {
  const list = [];
  if (location.protocol.startsWith('http')) list.push(location.origin);
  for (const u of [SERVER_URL, LAN_FALLBACK_URL]) if (!isPlaceholder(u) && !list.includes(u)) list.push(u);
  return list;
}

function tryConnect(url) {
  return new Promise((resolve) => {
    const socket = io(url, {
      transports: ['websocket', 'polling'],
      // ngrok's free tier shows a browser warning page unless this header is present (polling only;
      // the websocket transport, tried first, is not affected).
      extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
      reconnection: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    const done = (ok) => {
      clearTimeout(timer);
      socket.off('connect').off('connect_error');
      if (!ok) socket.close();
      resolve(ok ? socket : null);
    };
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS + 500);
    socket.once('connect', () => done(true));
    socket.once('connect_error', () => done(false));
  });
}

// Returns a connected socket (with auto-reconnect switched on) and the URL it reached.
export async function connectToServer(onAttempt = () => {}) {
  for (;;) {
    for (const url of candidateUrls()) {
      onAttempt(url);
      const socket = await tryConnect(url);
      if (socket) {
        socket.io.reconnection(true);
        return { socket, url };
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
