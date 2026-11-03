# Laptop A demo steps

Run all commands from the project root (the folder with `package.json`).

## One-time setup: Groq key for the AI features

The IQ roast and AI coach hints call Groq. The key is not in git, so each laptop that runs the server needs its own `server/.env`.

1. `git pull && npm install`
2. `cp server/.env.example server/.env`
3. Get a free key at https://console.groq.com/keys (Create API Key, then copy it right away; Groq shows it only once).
4. Open `server/.env` and paste it after `GROQ_API_KEY=`, with no quotes or spaces. Save.

Without a key the game still works, but hints use the plain solver wording and the IQ comes from a formula. To check the key works: after a match, the end screen says "Estimated by an AI model", and hints start with "AI coach:". If not, look for `[iq]` or `[hint]` warnings in the server terminal.

## Every demo

1. Terminal 1, server: `npm run build && npm start`. Wait for it to say the server is listening on :3000.
2. Terminal 2, tunnel: `npm run tunnel`. Wait for ngrok to show the session as online.
3. Browser: open http://localhost:3000/admin for the admin page.
4. Browser: open http://localhost:3000 for player 1, and enter a nickname.
