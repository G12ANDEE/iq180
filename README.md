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

Optional AI key for the IQ roast: copy `server/.env.example` to `server/.env` and set `GROQ_API_KEY` (free at https://console.groq.com → API Keys). Any OpenAI-compatible endpoint also works via `LLM_BASE_URL`/`LLM_MODEL`, e.g. local Ollama. Without a key, a built-in formula is used, so the game still works.

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
| Targets | Integers 1–99 on Normal (`TARGET_MAX` env to change); Easy and Hard use their own ranges (see Difficulty modes). |
| Timeout | Everyone sees **Lost** ("Time's up") and nobody gets a point. |
| More than two clients | Everyone races the same puzzle (no seat cap). Anyone arriving mid-round waits in the queue and is seated next round; a match needs at least two racers (or one + the bot) and starts only once every racer has clicked "Play with other players". |
| Duplicate nickname | Gets a suffix: `Alice (2)`. |
| Disconnect mid-match | The race continues while at least two racers remain; otherwise it ends with no point and the rest return to the lobby. |
| Two correct answers at once | The first one the server receives wins. A late or duplicate submission is rejected. |
| Rematch | Starts only after **every racer still in the match** presses Rematch. New digits, target and key solution. |
| Reset (admin) | Clears all scores and the current match, notifies everyone, and returns everyone to the lobby; a new match starts once the players opt in again. |
| Admin access | Only from the server computer itself. Requests arriving through ngrok are refused even though ngrok connects from localhost, because they carry forwarding headers. |
| Privacy | Opponents never receive each other's attempts, wrong answers or hints. The winning expression is revealed only at match end. |

## Fixes to the original handoff doc

- *"Tunnel URL as the config constant"*: quick-tunnel URLs change on every restart. Fixed by using an ngrok **free static domain**, which never changes, plus a LAN fallback.
- *"Laptop B opens the tunnel URL in a browser"*: typing a URL could count as entering the address. Laptop B runs `npm run client`, which knows the address from source.
- *"Restrict /admin to localhost"*: a tunnel connects from localhost, so this alone would let anyone reset the game. Also rejects forwarded requests.
- ngrok's free tier shows a browser-warning page to browsers. The client connects over WebSocket first and sends `ngrok-skip-browser-warning` on HTTP polling, so the page never interferes.

## Extra features

AI features come first, then the rest, grouped by what they do.

| # | Group | Feature | AI |
|---|---|---|---|
| 1 | AI: opponent | **AI opponent (bot)**: pick "Play the AI bot" from the lobby, even when other people are connected (they wait in the queue until you switch back to them). It is driven by a free LLM (any OpenAI-compatible endpoint; Groq by default), with easy/medium/hard difficulty that sets how fast and how reliably it answers | ✓ |
| 2 | AI: opponent | **Bot brain cam**: while racing the AI opponent you see a solving-progress bar and the LLM token cost for the round, compared with the previous round ("0 tokens" when no key is set). The step-by-step trace is shown only on `/admin`, so the bot's working is never revealed mid-match | ✓ |
| 3 | AI: coaching & feedback | **AI coach hints**: an exhaustive solver picks a real sub-step of a real solution, and the LLM rewrites it as a coach-style nudge. The rewrite is accepted only if it keeps the solver's exact expression and doesn't leak the full answer; otherwise the plain solver hint is shown (2 per match, private to that player) | ✓ |
| 4 | AI: coaching & feedback | **Match IQ roast**: after each match, an LLM (gpt-oss-120b via Groq) estimates a tongue-in-cheek IQ and writes a one-line roast for each player from their attempts, wrong answers, hints used and solve time | ✓ |
| 5 | Matchmaking & flow | **Opt-in matches and waiting queue**: nobody is pulled into a match; it starts once every seated player clicks "Play with other players". Anyone arriving mid-round, or while someone races the bot, waits in the queue and is seated at the next opportunity |  |
| 6 | Matchmaking & flow | **Opponent appeared!** (bot handoff): when a person joins while you race the AI, the match pauses (clock and bot frozen) and you choose "Join the challenge" or "Continue with bot"; it auto-continues with the bot after 20 s, and a banner lets you switch to players later. If you picked the bot while people were already waiting, there is no pop-up, only the banner |  |
| 7 | Matchmaking & flow | **Surrender**: a 🏳 button (with confirmation) gives up the round and returns you to the lobby; against a person the other racer is told, against the bot the match simply ends |  |
| 8 | Game modes | **Difficulty modes** (separate mode): Easy (targets 1–20, 90 s) / Normal (1–99, 60 s) / Hard (50–200, 45 s); picked in the lobby and shown on `/admin` |  |
| 9 | Game modes | **Win-streak bonus** (separate mode): consecutive wins are worth escalating points (1, 2, 3…) instead of a flat point |  |
| 10 | Building your answer | Live expression preview: shows the current value, and the missing-digit warning, as you build |  |
| 11 | Building your answer | Keyboard play: digits, `+ - * / ( )`, Backspace to undo, Esc to clear, Enter to submit |  |
| 12 | Look & feel, history | **Match history**: the last several rounds (digits, target, winner, solution) in the lobby and on `/admin` |  |
| 13 | Look & feel, history | **Sound effects**: synthesised with the Web Audio API (tile taps, submit, win/lose, final-seconds tick), with a mute toggle |  |
| 14 | Look & feel, history | **Theme switcher**: Cobalt / Neon / Sunset palettes, remembered across visits |  |

## Layout

```
shared/   fraction.js (exact math) · expr.js (parser + judge) · solver.js (all solutions, hint steps)
server/   index.js (Express + socket.io) · game.js (match state machine) · generator.js · llm.js (OpenAI-compatible client) · iq.js · hint.js · bot.js · bot-brain.js · admin/
client/   index.html · src/{main.js, net.js, config.js, style.css, sound.js}
scripts/  tunnel.js (starts ngrok on SERVER_URL)
tests/    expr, solver/generator, game flow over real sockets
```
