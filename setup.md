# Laptop A demo steps

Run all commands from the project root (the folder with `package.json`).

1. Terminal 1, server: `npm run build && npm start`. Wait for it to say the server is listening on :3000.
2. Terminal 2, tunnel: `npm run tunnel`. Wait for ngrok to show the session as online.
3. Browser: open http://localhost:3000/admin for the admin page.
4. Browser: open http://localhost:3000 for player 1, and enter a nickname.
