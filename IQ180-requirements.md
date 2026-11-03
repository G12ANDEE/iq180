# IQ180: Project Requirements (Handoff)

Course assignment, Netcentric Architecture (2190472). Total 25 points: demo and creativity 5, fundamentals 10, extras up to 10. **Extras only count if the fundamentals are complete.**

## 1. Goal

A real-time online math race game built with socket programming in a client-server model. Everyone in the room races the same puzzle (a match needs at least two racers, or one person plus the AI bot). All racers get the same five digits (0-9) and a target number. They race for 1 minute to build an arithmetic expression from the digits that equals the target. First correct solver wins points (1 by default; escalating in streak mode).

## 2. Chosen stack (fixed)

| Layer | Choice |
|---|---|
| Server | Node.js (+ Express to serve static files and the admin page) |
| Sockets | socket.io v4 |
| Client app | Vite (vanilla JS/TS or React, implementer's choice) |
| Hosting | Tunnel link (ngrok / cloudflared / similar) pointing at the Node server |

### Deployment shape
- Run `vite build`, then have Express serve `dist/`. One process, one port, one tunnel. Do not run `vite dev` on demo day.
- The client connects to its own origin, so there are no CORS problems.
- The server address must live **in source code** as a single config constant (the tunnel URL). The player must never be asked to type an IP or port. If the client connects to its own origin, document that the tunnel URL is the address.
- socket.io must allow the `websocket` transport (not only polling), and must work through the tunnel.
- Keep a LAN fallback (server's local IP on the same wifi) in case the tunnel or venue wifi fails.

## 3. Hard requirements from the brief

1. Client and server communicate via socket programming, client-server model.
2. The game client is deployed on at least two computers.
3. Setup: computer A runs the server and a game client; computer B runs only a game client, connecting directly to the server.
4. Clients do not enter an IP or port. Address is set in source.
5. A client connects to the server first, and the server tells it which other clients are connected.
6. Each player enters a nickname before the game starts, then sees "Welcome, <nickname>."
7. The server randomly generates five digits (0-9) and a target result that is solvable from those digits, before the match begins, and keeps a key solution.
8. The server program displays: (1) number of concurrent connected clients, (2) list of connected clients, (3) key solution of the current match.
9. The client shows the player's name and score.
10. At match start all racers see the five digits and the math operations.
11. All racers play concurrently. First player to correctly solve wins and gets 1 point.
12. 1-minute countdown per match.
13. Each digit can be used only once. Once a digit is selected, it is disabled in the UI.
14. Players cannot see the other players' actions until the match ends.
15. At match end the client shows "Win" or "Lost", every racer's current score, and a Rematch button.
16. If every racer still in the match agrees to a rematch, the server generates five new digits and a new target and updates the key solution.
17. The server has a reset button that resets the game and the players' scores.

## 4. Architecture

### Authority
**The server owns all game state.** It runs the timer, validates expressions, enforces digit usage, decides the winner and updates scores. The client is only a view. Never trust the client for correctness or for time.

### Server state (per room / match)
- `players`: socket id, nickname, score, connected flag
- `digits[5]`, `target`, `keySolution` (expression string)
- `phase`: `lobby` | `ready` | `playing` | `finished`
- `seats[]` (racers in this/next match, no cap) and `queue[]` (arrived mid-round, seated at the next round)
- `paused` (bot match frozen while a human is being offered), `keepBot`, `bot`, `mode` (difficulty + streak)
- `endsAt` (server timestamp), `winnerId | null`
- `rematchVotes`: set of player ids

### Suggested socket.io events

Client to server:
- `join { nickname }`
- `submit { expression }`
- `rematch`
- `add_bot { difficulty }`, `remove_bot`, `bot_choice { choice: "bot" | "humans" }`, `set_mode`
- `hint`

Server to client:
- `welcome { nickname, players[] }`
- `players_update { players[] }` (names and scores, used to show who is connected)
- `match_start { digits[], target, endsAt, scores }`
- `match_end { result: "win" | "lost", winner, scores }`
- `get_ready { startsAt, serverNow, matchNo, mode }` (3-2-1 countdown before the match)
- `rematch_status { votes, needed }`
- `opponent_appeared { names, paused, autoMs }` (to the person racing the bot when a human joins)
- `match_resumed { endsAt }`, `match_aborted { reason }`
- `bot_think`, `iq_report`, `hint`, `extras`, `join_error`
- `submit_rejected { reason }` (invalid expression, digit reuse, wrong value, not your match)
- `reset` (scores cleared)

Do **not** broadcast one player's in-progress input or submissions to the other. Only the final result goes out at match end.

### Admin page (server display and reset button)
A terminal cannot hold a button, so serve `/admin` from the same Node server, to be opened on the server computer. It shows:
- number of connected clients (live)
- list of connected clients (nickname, score)
- key solution of the current match
- **Reset button** (resets match and all scores, notifies clients)

Optionally restrict `/admin` to localhost so players cannot reset the game.

## 5. Game logic

### Expression rules
- Allowed operators: `+ - x /` (the UI shows these four). Parentheses are optional; see open questions.
- Each of the five digit tokens can be used at most once. The server verifies this from the submitted token list, not just the UI.
- Do **not** use `eval()` on client input. Write a small tokenizer and parser (recursive descent or shunting-yard) and evaluate with exact arithmetic (integers or fractions), so `7/2*2` is exactly 7, not a float rounding issue.
- Division by zero is invalid.
- Prefer a structured submission (array of tokens) over a raw string.

### Solvable target generation
1. Generate five random digits 0-9.
2. Build a random valid expression from some or all of them using the allowed operators.
3. Evaluate it exactly. Accept only if every intermediate step is valid and the final result is an integer within a sensible range (for example 1 to 999, tunable).
4. Use that result as the target and that expression as the key solution. Retry on failure.
5. Alternative: brute-force solver over permutations and operator choices, which is also reusable for the AI hint feature.
6. Regenerate on every rematch and update the admin display.

### Match flow
1. At least two racers (or one person plus the bot) are connected and have nicknames. The server runs a short get-ready countdown, then starts the match, setting `endsAt = now + 60s`.
2. Players submit. First correct submission (by server receive time) wins: +1 point (more in streak mode), phase becomes `finished`, every client gets `match_end`.
3. If the timer hits 0 with no correct answer, the match ends with no point awarded (see open questions for labels).
4. Rematch only starts when **every racer still in the match** has pressed Rematch (a racer leaving can complete the vote).
5. Reset from the admin page clears scores and the match, and returns to the lobby.

### Edge cases to handle
- More than two clients connected: **decided**: all join the same race. Anyone arriving mid-round waits in the queue and is seated at the next round; during the get-ready countdown they can still join.
- A player disconnects mid-match: the race continues while at least two racers remain; otherwise the match is aborted and the lobby updated.
- A human joins while someone is racing the bot: the bot match is paused (clock and bot answer frozen) and the bot's player sees "Opponent appeared!" with "Join the challenge" / "Continue with bot". No answer within `BOT_PROMPT_MS` (20 s) auto-continues with the bot. If the newcomer leaves again, the match resumes. After choosing the bot, a banner offers "Play with players" at any time.
- The bot can only be added by a lone seated player with an empty queue, and leaves with that player.
- Duplicate nicknames: reject or suffix.
- A late or double submission after the match has ended is ignored.
- Reconnect during a match should not crash the server.

## 6. Client UI

Per the example layout:
- Title "IQ180"
- Countdown (00:01:00, driven by the server's `endsAt`, so clocks stay consistent)
- Both players' names and scores
- Five digit buttons, each disabled after it is picked
- Operator buttons `+ - x /` (and `( )` if allowed)
- Expression display with a clear/undo control, `= target`
- Submit
- End screen: "Win" or "Lost", both scores, Rematch button
- Nickname entry screen with welcome message "Welcome, <nickname>."
- A visible list of other connected clients (required by the "client receives info about other clients" point)

## 7. Score rubric mapped to deliverables (fundamentals = 10 points)

| Pts | Item | How to satisfy |
|---|---|---|
| 1.0 | System setup: all requirements done | Everything in section 3 works |
| 0.5 | One computer runs server and a client | Demo laptop A |
| 0.5 | Another computer runs only a client, connected directly to the server | Laptop B via tunnel (or LAN) |
| 0.5 | No manual IP or port entry | Address in source |
| 1.0 | Client connects first and receives info on other clients | `players_update` / client list |
| 0.5 | Nickname and welcome message | Nickname screen |
| 0.5 | Name and score on client | Header |
| 0.5 | Five digits and operations provided | Match screen |
| 0.5 | 1-minute countdown | Server-driven timer |
| 0.5 | Selected digit disabled | UI state |
| 0.5 | Score updated, status and scores shown at end | End screen |
| 0.5 | Rematch | Both-agree flow |
| 1.0 | Server shows online count and client list | `/admin` |
| 1.0 | Server reset button | `/admin` |
| 0.5 | Server generates solvable key and shows at least one solution | Generator + `/admin` |
| 0.5 | New key solution on rematch | Regenerate and refresh admin |

## 8. Extra features (up to 10 points, after fundamentals are done)

- AI feature: 2 points each, **at least one AI feature is required to earn any extra points**. Non-AI feature: 1 point each.
- A feature that changes the base design must be a separate mode.
- Cheap AI options: an LLM-powered or solver-powered hint (spend-a-hint mode), a bot opponent that "races" with a human-like delay, difficulty tuning from player history.
- Implemented so far: 4 AI (IQ roast, coach hints, AI opponent, bot brain cam) and 10 non-AI (see README "Extra features"). Already over the 10-point cap.
- Cheap non-AI options: sound effects, leaderboard, spectator mode, match history, themes, streak bonuses, difficulty levels.
- Fill the extra-features table (feature name and AI flag) for submission.

## 9. Demo day checklist

- [ ] `vite build` done, server started, tunnel up, tunnel URL set in source and tested
- [ ] Laptop A: server + `/admin` + one client. Laptop B: client only
- [ ] Tested through the tunnel with WebSocket transport, not just localhost
- [ ] LAN fallback tested
- [ ] Full cycle tested: join, play, win, lose, timeout, rematch, reset
- [ ] Two simultaneous submissions tested (only one winner)
- [ ] Extra features table filled in

## 10. Open questions (confirm with the TA or decide and document)

1. Must a solution use all five digits, or any subset? (Brief says "each digit can be used only once", which implies a subset is allowed.)
2. Are parentheses allowed? Is concatenating digits (for example 3 and 3 into 33) allowed? Default assumption: no concatenation.
3. What does the client show on a timeout with no winner? Brief only defines "Win" and "Lost". Suggested: both see "Lost" (or "Time's up") and no point is awarded.
4. Is a tunnel acceptable as "connects directly to the server", and does a browser on laptop B count as "runs only the game client"?
5. Behavior for a third or later client (queue vs spectator).
