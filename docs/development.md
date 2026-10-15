# Development and configuration

[Back to the README](../README.md)

## Running locally with Node.js

Use Node.js 24 or later and Yarn Classic 1.22. The Docker images use Node 24 on
Debian Bookworm. `node:sqlite` is built in; no separate SQLite installation is
required. SSH uses `ssh2`; optional native optimizations are not required.

```sh
yarn install --frozen-lockfile
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
# Set CREDENTIAL_ENCRYPTION_KEY in .env to the generated key.
chmod 600 .env
yarn build
yarn start
# During development: yarn dev
# Tests: yarn test
```

The key is required: exactly 32 random bytes encoded as canonical base64.
Store it separately from the database and keep it secret. The server loads `.env`
at startup; existing process environment variables take precedence. Importing the
runtime does not start a listening server. SIGINT/SIGTERM stops polling, closes
WebSockets and HTTP, then closes SQLite. Active HTTP requests get up to ten seconds
to finish; polling shutdown waits for the active round.

| Variable | Value / purpose |
| --- | --- |
| `NODE_ENV` | `production` (default) or `development` |
| `HOST` | `127.0.0.1` (default); bind locally behind the HTTPS proxy |
| `PORT` | `3000` (default), integer from 1 to 65535 |
| `DATABASE_PATH` | `./data/lightning.sqlite` (default); Docker: `/app/data/lightning.sqlite` |
| `FRONTEND_ORIGIN` | Exact origin without a path or trailing slash; production requires HTTPS; development defaults to `http://localhost:5173` |
| `CREDENTIAL_ENCRYPTION_KEY` | Required base64 key; never replace it without migrating stored credentials |

The `lightning_session` cookie is HttpOnly, SameSite=Strict, and Secure in
production, with a seven-day lifetime. Only the token hash is stored in the
database. Credentials use AES-256-GCM encryption bound to the computer and owner.

## Browser clients

Locally, use `http://localhost:5173` for the frontend and `http://localhost:3000`
for the API, with `NODE_ENV=development`. Use the same hostname: do not mix
`localhost` and `127.0.0.1`. Include `credentials: 'include'` in fetch requests.
The API does not serve a frontend.

```js
await fetch('http://localhost:3000/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'operator@example.com', password: 'example-password-123' })
})
const socket = new WebSocket('ws://localhost:3000/ws/computers')
socket.onmessage = event => console.log(JSON.parse(event.data))
```

The browser sends the HttpOnly cookie automatically. Do not put session tokens in
URLs. Non-browser clients use a cookie jar; see the [API reference](api.md).

## Running locally with Docker

See [Docker and deployment](deployment.md#local-http-development) for the
development override. It uses `.env.production` for the encryption key and
existing database, but explicitly sets the runtime to development.

## Checks

```sh
yarn test
yarn build
```

Tests use SQLite, Hono, authentication, and WebSocket framing over in-memory
streams. TCP, SSH, and WOL operations are replaced with test adapters.
Also verify WOL and shutdown on real hardware.
