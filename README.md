# IQ180

A real-time two-player math race (Netcentric Architecture 2190472). The server deals five digits (0–9) and a target, and the first player to build an expression that hits the target wins the point. You have 60 seconds.

Stack: Node.js + Express + socket.io v4 (server), Vite + vanilla JS (client), ngrok free static domain (public address).

## How it fits together

```
 Laptop A (server computer)                      Laptop B (client only)
 ┌──────────────────────────────┐               ┌───────────────────────────┐
 │ npm start  → Node server:3000│◀── ngrok ─────│ npm run client            │
 │   • game logic, timer, scores│   static URL  │   serves client locally,  │
 │   • /admin (count, list, key,│               │   connects to SERVER_URL  │
 │     reset button)            │◀── LAN IP ────│   (fallback)              │
 │ browser → localhost:3000     │   (fallback)  └───────────────────────────┘
 └──────────────────────────────┘
```

- **The server is authoritative.** It runs the timer, checks every submission and decides the winner. Clients only render state and send intents (`join`, `submit`, `hint`, `rematch`).
- **The server address is in source code.** It lives in [client/src/config.js](client/src/config.js). The client tries, in order: its own origin (when served by the server), `SERVER_URL` (ngrok static domain), then `LAN_FALLBACK_URL`. Players never type an IP, port or URL.
- **The server display** is `/admin` on laptop A: live online count, client list, key solution and a Reset button. The server terminal prints the same status line whenever anything changes.

## One-time setup

On **both** laptops (Node 18+):

```bash
npm install
```

On **laptop A**, set up ngrok once:

1. Sign up at https://dashboard.ngrok.com (free).
2. Copy your authtoken from *Your Authtoken* and run `ngrok config add-authtoken <token>`.
3. Under *Domains*, copy your free static domain (e.g. `something-something.ngrok-free.dev`; free accounts get one auto-assigned name).
4. Put it in `client/src/config.js` → `SERVER_URL = 'https://something-something.ngrok-free.dev'`.
5. Optional: set `LAN_FALLBACK_URL` to laptop A's Wi-Fi IP. `npm start` prints it.

Copy the same `client/src/config.js` to laptop B (commit it, or AirDrop the project folder).

Optional AI key for the IQ roast: copy `server/.env.example` to `server/.env` and set `ANTHROPIC_API_KEY`. Without a key, a built-in formula is used, so the game still works.

## Demo day

Laptop A, three terminals:

```bash
npm run build && npm start      # game server on :3000
npm run tunnel                  # ngrok → your static domain
open http://localhost:3000/admin   # server display + reset
open http://localhost:3000         # player 1
```

Laptop B:

```bash
npm run client                  # builds, serves the client and opens the browser
```

`npm test` runs the unit and socket integration tests.

## Rules and decisions

| Question | Decision |
|---|---|
| Use all five digits? | **Yes**, each exactly once. The generator only picks targets reachable with all five. |
| Operators | `+ − × ÷` and parentheses. No concatenation (`3`,`3` ≠ `33`). Division by zero is invalid. |
| Arithmetic | Exact fractions (no `eval`, no floats), so `7 ÷ 2 × 2 = 7`. Intermediate fractions are fine; the result must equal the target. |
| Targets | Integers 1–99 (`TARGET_MAX` env to change). |
| Timeout | Both players see **Lost** ("Time's up") and nobody gets a point. |
| More than two clients | Clients 3+ wait in a queue and show in everyone's player list. They take the next free seat. |
| Duplicate nickname | Gets a suffix: `Alice (2)`. |
| Disconnect mid-match | Match ends with no point. The opponent returns to the lobby, and the next queued player is seated. |
| Two correct answers at once | The first one the server receives wins. A late or duplicate submission is rejected. |
| Rematch | Starts only after **both** players press Rematch. New digits, target and key solution. |
| Reset (admin) | Clears all scores and the current match, notifies everyone, and starts a fresh match if two players are present. |
| Admin access | Only from the server computer itself. Requests arriving through ngrok are refused even though ngrok connects from localhost, because they carry forwarding headers. |
| Privacy | Opponents never receive each other's attempts, wrong answers or hints. The winning expression is revealed only at match end. |

## Fixes to the original handoff doc

- *"Tunnel URL as the config constant"*: quick-tunnel URLs change on every restart. Fixed by using an ngrok **free static domain**, which never changes, plus a LAN fallback.
- *"Laptop B opens the tunnel URL in a browser"*: typing a URL could count as entering the address. Laptop B runs `npm run client`, which knows the address from source.
- *"Restrict /admin to localhost"*: a tunnel connects from localhost, so this alone would let anyone reset the game. Also rejects forwarded requests.
- ngrok's free tier shows a browser-warning page to browsers. The client connects over WebSocket first and sends `ngrok-skip-browser-warning` on HTTP polling, so the page never interferes.

## Extra features

| # | Feature | AI |
|---|---|---|
| 1 | **Match IQ roast**: after each match, Claude estimates a tongue-in-cheek IQ and writes a one-line roast for each player from their attempts, wrong answers, hints used and solve time | ✓ |
| 2 | **Solver hints**: an exhaustive expression solver finds real solutions and reveals one sub-step per hint (2 per match, private to that player) | ✓ |
| 3 | **AI opponent (bot)**: fills an empty seat and races you, driven by a free LLM (any OpenAI-compatible endpoint; Groq by default), with easy/medium/hard difficulty | ✓ |
| 4 | Live expression preview: shows the current value, and the missing-digit warning, as you build | |
| 5 | Keyboard play: digits, `+ - * / ( )`, Backspace to undo, Esc to clear, Enter to submit | |
| 6 | Waiting queue for 3+ clients with automatic seat promotion | |
| 7 | **Difficulty modes** (separate mode): Easy / Normal / Hard change the target range and the countdown length; picked in the lobby and shown on `/admin` | |
| 8 | **Win-streak bonus** (separate mode): consecutive wins are worth escalating points (1, 2, 3…) instead of a flat point | |
| 9 | **All-time leaderboard**: wins and best streak per nickname, persisted to disk, shown in the lobby and on `/admin` | |
| 10 | **Match history**: the last several rounds (digits, target, winner, solution) in the lobby and on `/admin` | |
| 11 | **Sound effects**: synthesised with the Web Audio API (tile taps, submit, win/lose, final-seconds tick), with a mute toggle | |
| 12 | **Theme switcher**: Cobalt / Neon / Sunset palettes, remembered across visits | |
| 13 | **Bot brain cam**: while racing the AI opponent, watch its solving logic appear step by step, with the Groq token cost for the round and how it compares to the previous round (falls back to the solver's own step trace and "0 tokens" when no key is set) | ✓ |

## Layout

```
shared/   fraction.js (exact math) · expr.js (parser + judge) · solver.js (all solutions, hints)
server/   index.js (Express + socket.io) · game.js (match state machine) · generator.js · iq.js · bot.js · leaderboard.js · admin/
client/   index.html · src/{main.js, net.js, config.js, style.css, sound.js}
scripts/  tunnel.js (starts ngrok on SERVER_URL)
tests/    expr, solver/generator, game flow over real sockets
```
