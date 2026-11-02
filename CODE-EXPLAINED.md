# IQ180 — Code Explained

> A file-by-file walkthrough of the IQ180 implementation, mapped to the
> assignment brief (`IQ180-requirements.md` / the PDF) and its 25-point rubric.
> The PDF itself contains **no code** — it is the assignment spec. All code lives
> in this `iq180/` project.

## Architecture at a glance

It's a **Node.js** project. The server uses **Express** (serves web pages) +
**Socket.IO** (the socket-programming layer carrying all game traffic). The
client is a browser app built with **Vite**. Logic shared by both lives in
`shared/`.

```
server/        → the "server program" from the brief (authoritative game room)
client/        → the "game client" from the brief (browser UI)
shared/        → math engine used by both (expression parser, solver, fractions)
server/admin/  → the server's own display screen (online count, key solution, reset)
```

**Design principle:** the server is authoritative. Clients only *send intents*
(`join`, `submit`, `hint`, `rematch`); the server owns the timer, validates
answers, decides the winner, and keeps the scores. The client is a pure *view*
of server state.

---

## `server/` — the server program

### `server/index.js` — entry point
Starts Express + Socket.IO, wires socket events to the game, prints server status.

- `startServer()` (line 21) boots HTTP + Socket.IO.
- `io.on('connection', …)` (line 41) is the heart of socket programming: it
  listens for each client intent — `join`, `submit`, `hint`, `rematch`,
  `disconnect` — and forwards them to the `Game`.
- `admin` namespace (line 30) is restricted to the local machine
  (`isLocalAdmin`, line 18) so only the server computer sees the admin page.
- `printStatus()` (line 89) prints the **online count, connected client list,
  and key solution** to the terminal — directly satisfies "the server program
  must display (1)(2)(3)."
- `printBanner()` (line 79) prints the URLs, including the LAN address.

### `server/game.js` — the authoritative game room
The single source of truth. Clients only *ask*; the server *decides*.

- `connect` / `join` / `disconnect` (lines 32–65): tracks clients, assigns the 2
  "seats," queues extras, enforces unique nicknames.
- `beginGetReady` → `startMatch` → `endMatch` (lines 76–149): the match
  lifecycle. The puzzle is generated **before** the match starts (line 79) so the
  key solution is ready. The 60-second timer (`MATCH_MS`) is set at line 107.
- `submit` (line 110): server-side validation. Because Node processes one event
  at a time, **the first correct submission wins outright** (line 122 comment) —
  the fairness guarantee the brief wants.
- `endMatch` (line 128): awards the point, emits `win`/`lost` to each player with
  both scores and the key solution.
- `rematch` (line 159): both players must vote; when both agree it starts a new
  match with new digits.
- `reset` (line 179): clears all scores back to 0 — backs the server reset button.
- `adminState` (line 261): the payload the admin screen renders.

### `server/generator.js` — puzzle generation
`generatePuzzle()` deals 5 random digits and picks a target that is **provably
solvable** (it runs the solver, keeps only reachable targets). Satisfies
"randomly generates a solvable key solution."

### `server/config.js` — settings
All tunable settings via env vars: `PORT`, `MATCH_MS` (60s), target range, max
hints, and the Claude model ID. Fixing the port/address here is what lets clients
connect *without typing an IP*.

### `server/iq.js` — the AI feature
After each match it sends the players' stats (solve time, wrong attempts, hints
used) to **Claude** (`claude-opus-5-5`), which returns a playful "IQ score" and a
one-line roast per player. If there's no API key or the call fails, `fallback()`
(line 67) computes an IQ with a local formula instead. This is the "At least one
AI feature is required" rubric item.

### `server/admin/admin.js` (+ `index.html`, `admin.css`) — the server display
The **server's display screen** (the reset button lives here). `render()`
(line 16) shows the live online count, the client table, and the **key solution +
alternate solutions**. The reset button (line 39) emits `admin_reset`.

---

## `shared/` — the math engine (used by server and client)

### `shared/fraction.js` — exact rational arithmetic
Using fractions instead of floats means `7 ÷ 2 × 2` is exactly `7`, never
`6.9999`. Prevents rounding bugs in answer-checking.

### `shared/expr.js` — expression validator / evaluator
- `checkTokens` (line 22): enforces the rules — **each digit used only once**
  (line 30), all digits used, valid operators.
- `evaluate` (line 44): a safe recursive-descent parser. Crucially, the client
  submits a **token array, never a string to `eval()`** (line 1) — the
  security-safe design.
- `judge` (line 89): the server's full verdict on a submission (`ok` / reason).

### `shared/solver.js` — exhaustive solver
Exhaustively combines the 5 digits with `+ − × ÷` to find *every* reachable
target (`solveAll`, line 19). Used to guarantee solvable puzzles, to produce the
**key solution** shown on the admin screen, and to generate **progressive hints**
(`hintsFor`, line 84).

---

## `client/` — the game client

### `client/src/config.js` — server address
Hard-codes the server address (ngrok URL + LAN fallback). This is *why players
never enter an IP or port* — exactly what the brief requires.

### `client/src/net.js` — connection
`connectToServer()` tries each candidate URL in order and keeps the first that
answers, then enables auto-reconnect. The client side of socket programming.

### `client/src/main.js` — the game UI
The entire client UI. A pure "view of server state" (line 1) — it never decides
correctness or time, it just renders and sends intents.

- Screens: `connecting → nickname → lobby → ready → match → end`.
- `viewNickname` (line 162) + welcome line in `viewLobby` (line 192) → nickname
  entry & "Welcome, Alice."
- `scoreline` (line 209) → both players' names + scores + the countdown clock.
- `viewMatch` (line 219) → the 5 digit tiles, operator buttons, live expression.
  Used digits are `disabled` (line 230) — satisfies "each selected digit is
  disabled."
- `tickClock` (line 126) → the 1-minute countdown (purely visual; server owns the
  real clock).
- `viewEnd` (line 250) → **Win/Lost** status, both scores, the key solution, the
  AI "IQ" cards, and the **Rematch** button.
- Keyboard input (line 315) lets you type digits/operators instead of clicking.

---

## Feature-by-feature explanation

Each feature from the brief and the rubric, explained with how the code makes it work.

### 1. Socket-based client–server communication
The whole game runs over **Socket.IO** (socket programming on top of WebSockets).
The server opens a socket listener in `server/index.js:41` (`io.on('connection', …)`)
and registers one handler per intent the client can send: `join`, `submit`,
`hint`, `rematch`, `disconnect`. The client opens its socket in
`client/src/net.js` and emits those same events. Nothing about the game is sent
over plain HTTP — HTTP only serves the static page files.

### 2. Two-computer setup (server + client on one, client on the other)
`npm start` runs the server (`server/index.js`), which also serves the client
page, so computer A runs both. Computer B just opens the page in a browser and
its client connects back over the socket. `printBanner()` (`index.js:79`) prints
the LAN/tunnel URLs computer B uses.

### 3. Connect to the server without typing an IP or port
The server address is hard-coded in `client/src/config.js` (ngrok URL + LAN
fallback). `connectToServer()` in `client/src/net.js` tries each candidate URL in
order and keeps the first that answers, so the player never enters an address.

### 4. Connect first, then see the other connected clients
On connect, `Game.connect()` (`game.js:32`) registers the client and immediately
sends it the current player list (`players_update`). Every join/leave calls
`broadcastPlayers()` (`game.js:254`), which pushes an updated roster to everyone,
so each client always knows who else is online (rendered in `rosterHtml`,
`main.js:175`).

### 5. Nickname entry + "Welcome, <name>."
The client shows a nickname form in `viewNickname` (`main.js:162`) and emits
`join`. The server cleans and de-duplicates the name in `Game.join()`
(`game.js:38`, `uniqueName` at line 218), then the client shows the welcome line
in `viewLobby` (`main.js:192`: `Welcome, <nickname>.`).

### 6. Player name and score shown on the client
`topbar()` (`main.js:149`) shows your name and live score; `scoreline()`
(`main.js:209`) shows both players' names and scores during a match. Scores come
from the server's `players_update` payload, so they're always authoritative.

### 7. Five random digits and math operations each match
`generatePuzzle()` (`server/generator.js:8`) deals five random digits (0–9).
The client renders them as tiles plus the `+ − × ÷` and parenthesis buttons in
`viewMatch` (`main.js:219`). Both players receive the *same* digits/target via
the `match_start` event (`game.js:96`).

### 8. Solvable target + key solution generated before the match
The generator doesn't just pick a random target — it runs the exhaustive solver
(`shared/solver.js:solveAll`) and only chooses a target that is actually
reachable with all five digits (`generator.js:12`). It stores a human-readable
`keySolution` so the server can display at least one guaranteed solution.

### 9. One-minute countdown timer
The authoritative timer is on the server: `startMatch()` sets `endsAt` and a
`setTimeout` for `MATCH_MS` (60s) at `game.js:107`. The client clock in
`tickClock()` (`main.js:126`) is display-only and syncs to the server's clock via
a time offset, so both players see the same countdown and the server decides when
time is actually up.

### 10. Each digit can be used only once / is disabled after use
Two layers. On the client, a used digit tile is rendered `disabled`
(`main.js:230`) so you can't click it twice. On the server, `checkTokens()`
(`shared/expr.js:22`) rejects any submission that reuses a digit slot
(`expr.js:30`), so the rule is enforced even if a client is tampered with.

### 11. First to correctly solve wins and gets 1 point
Both players race concurrently. When a submission arrives, `Game.submit()`
(`game.js:110`) validates it with `judge()` (`shared/expr.js:89`). Because Node
handles one event at a time, the **first** correct submission received ends the
match outright (`game.js:122`). `endMatch()` (`game.js:128`) adds 1 point to the
winner.

### 12. Players cannot see each other's actions until the match ends
During play the server never broadcasts a player's in-progress expression. Each
client only sends its own `submit`/`hint` and only gets private responses
(`submit_rejected`, `hint` — sent back to that one socket). The opponent's work
stays hidden until `match_end`.

### 13. Match end: Win / Lost status, both scores, rematch button
`endMatch()` (`game.js:128`) emits `match_end` to each seat with their individual
`result` (`'win'` or `'lost'`), the winning expression, the key solution, and
both scores. The client renders all of this plus the Rematch button in
`viewEnd()` (`main.js:250`).

### 14. Rematch (both players must agree) → new digits & new key solution
`Game.rematch()` (`game.js:159`) collects a vote from each player; only when both
seats have voted does it call `beginGetReady()`, which generates a brand-new
puzzle and key solution (`game.js:76`). The client shows the pending-vote state
on the rematch button (`main.js:272`).

### 15. Server displays online count, client list, and key solution
Two places. The server terminal prints all three on every change via
`printStatus()` (`index.js:89`). The richer **admin screen** (`server/admin/admin.js`)
renders the live online count, a table of connected clients, and the key solution
plus alternate solutions (`admin.js:16`). The admin screen is locked to the
server computer only (`isLocalAdmin`, `index.js:18`).

### 16. Server reset button (reset game and scores)
The reset button is on the admin page (`admin.js:39`) and emits `admin_reset`.
The server handles it in `index.js:52`, calling `Game.reset()` (`game.js:179`),
which sets every player's score to 0, returns everyone to the lobby, and
broadcasts a `reset` message the clients display.

### 17. AI feature — match "IQ" and roast (extra points)
After each match, `server/iq.js` sends the players' stats (solve time, wrong
attempts, hints used) to **Claude** (`claude-opus-5-5`), which returns a playful
IQ number and a one-line roast per player (`iqReport`, `iq.js:33`). The result is
sent to clients as `iq_report` and rendered in `viewEnd()` (`main.js:257`). If
there's no API key or the call fails/time-outs, `fallback()` (`iq.js:67`) computes
an IQ from a local formula, so the feature always produces something.

### Bonus (non-AI) — progressive hints
`Game.hint()` (`game.js:168`) gives up to `MAX_HINTS` hints per match, generated
by `hintsFor()` (`shared/solver.js:84`). Hints are **progressive** (a small
sub-step first, then a bigger chunk, never the full answer) and sent privately to
the requesting player only.

---

## Feature → code map (the rubric)

| Rubric item | Where |
|---|---|
| Socket-based client-server | `server/index.js` (io events), `client/src/net.js` |
| No manual IP/port entry | `client/src/config.js` |
| Connect first + see other clients | `game.connect` / `broadcastPlayers`, `players_update` (`main.js:44`) |
| Nickname + "Welcome, X" | `game.join` + `viewLobby` (`main.js:192`) |
| Name & score on client | `scoreline` (`main.js:209`), `topbar` |
| 5 digits + operations | `generator.js` + `viewMatch` (`main.js:219`) |
| 1-minute timer | `MATCH_MS` (`config.js`), `startMatch` (`game.js:107`), `tickClock` |
| Each digit used once / disabled | `checkTokens` (`expr.js:30`), tile `disabled` (`main.js:230`) |
| First correct solver wins +1 | `submit` / `endMatch` (`game.js:110`, `128`) |
| Win/Lost + scores at end | `viewEnd` (`main.js:250`) |
| Rematch (both agree) | `game.rematch` (`game.js:159`), rematch button |
| Server shows online count + client list + key solution | `printStatus` (`index.js:89`) + `admin.js` |
| Server reset button | `admin.js:39` → `game.reset` (`game.js:179`) |
| **AI feature** | `server/iq.js` (Claude-generated IQ / roast) |
