// Starts ngrok on the free static domain written in client/src/config.js (single source of truth).
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const config = readFileSync(new URL('../client/src/config.js', import.meta.url), 'utf8');
const url = config.match(/SERVER_URL\s*=\s*'([^']+)'/)?.[1];
const port = process.env.PORT ?? 3000;

if (!url || url.includes('YOUR-STATIC-DOMAIN')) {
  console.error('Set SERVER_URL in client/src/config.js to your ngrok static domain first,');
  console.error('e.g. https://something-something.ngrok-free.app (dashboard.ngrok.com > Domains).');
  process.exit(1);
}
if (spawnSync('ngrok', ['version']).error) {
  console.error('ngrok is not installed. On macOS: brew install ngrok');
  process.exit(1);
}

console.log(`Tunnelling ${url} -> http://localhost:${port}  (Ctrl+C to stop)`);
const child = spawn('ngrok', ['http', `--url=${url}`, String(port)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
