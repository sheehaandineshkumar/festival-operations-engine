# Festival Operations Engine (server)

Run locally: `node server.js` then open http://localhost:3000 (sign in: Shortcircuits / 1234).
Tests: `node test.js`. No npm install needed (zero dependencies, Node 18+).

## Deploy (Render, free tier works for a demo)
1. Push this folder to a GitHub repo.
2. Render > New > Web Service > pick the repo. Runtime: Docker (uses the Dockerfile). Health check path: `/healthz`.
3. Environment variables: `FOE_USER`, `FOE_PASS` (change from the demo values), `FOE_SECRET` (any long random string; keeps sessions valid across restarts).
4. Render gives you an https URL. Cookies are marked Secure automatically behind https.
Railway, Fly.io or any VPS with Docker work the same way: `docker build -t foe . && docker run -p 3000:3000 -e FOE_PASS=... foe`.
Note: reports are saved to `state.json`; on free hosts the disk resets on redeploy (set DATA_DIR to a mounted volume to keep them).

## Files
- `engine.js` pure logic (crowd, volunteers, waste, trucks) · `server.js` login, reports API, `/api/plan`
- `public/index.html` dashboard · `public/login.html` sign-in page
