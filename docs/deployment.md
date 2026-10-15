# Docker and deployment

[Back to the README](../README.md)

The existing Dockerfile builds TypeScript inside the container. The host needs
Docker Engine and the Compose plugin; Node.js and Yarn do not need to be installed
separately. The API host must be able to reach the computers on the LAN.

## Local HTTP development

An explicit development override is available for Docker on your own computer:

For a new installation, create `.env.production` from `.env.example` and set
`CREDENTIAL_ENCRYPTION_KEY` to the output of `openssl rand -base64 32`.
Keep the existing key if you already have data. Also create `data/` and grant
UID/GID 1000 write access, as described in the production instructions below.

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
docker compose -f compose.yaml -f compose.dev.yaml logs -f --tail=50 api
```

This uses `NODE_ENV=development` and defaults to `FRONTEND_ORIGIN=http://localhost:5173`.
The database and encryption key from the existing Compose configuration remain in
use, so your existing account stays valid. `.env.production` is still required for
that key. Login and registration then use HttpOnly, SameSite=Strict, Path=/ and
Max-Age=604800, without Secure. Log in again after switching between HTTP
development and HTTPS production.

Use `localhost` for both the frontend and API (for example,
`http://localhost:5173` for the frontend and `http://localhost:3000` for the API),
and include `credentials: 'include'` in login, registration and authenticated
requests. To use a different frontend origin:

```sh
FRONTEND_ORIGIN=http://localhost:3001 docker compose -f compose.yaml -f compose.dev.yaml up -d
```

The override reads `FRONTEND_ORIGIN` from the shell or the local `.env`, falling
back to localhost:5173. Setting only `NODE_ENV=development` in an environment file
is not enough for the base Compose configuration: it forces production.

## Production with HTTPS

Docker Engine and the Compose plugin must be installed on the server. The
multi-stage image installs dependencies using the lockfile, compiles TypeScript
and runs as the unprivileged `node` user. The host directory `./data` is mounted
at `/app/data`. Create that directory beforehand and grant the container user
write access:

```sh
mkdir -p data
sudo chown -R 1000:1000 data
```

Use a dedicated environment file:

```sh
cp .env.example .env.production
chmod 600 .env.production
# Set NODE_ENV=production, FRONTEND_ORIGIN=https://app.example.com and the key.
# Generate a key only for a new installation:
# openssl rand -base64 32
docker compose config --quiet
docker compose build
docker compose up -d
docker compose logs --tail=20 api
curl -i http://127.0.0.1:3000/auth/me   # Without a cookie: 401 JSON
# Then check the same API examples over HTTPS and WSS in the browser.
docker compose stop
# Restart and check that registered computers are preserved:
docker compose up -d
```

`network_mode: host` is intended for Linux here: it shares the host network stack,
reduces network isolation and enables LAN broadcasts. There are no `ports`
mappings. The API binds to localhost on the host, and the HTTPS proxy runs on the
host. The Compose environment forces production, localhost, port 3000 and the
database path in the mounted data directory. `restart: unless-stopped` restarts
the service; `init: true` helps with signal handling and process cleanup. Secrets
are injected through `.env.production` at runtime and are not baked into the
image. Do not publish `docker compose config` output containing secrets; use
`--quiet`. `.dockerignore` excludes secrets, local data and configuration.

## Reverse proxy and cookies

Place a reverse proxy on the host in front of `127.0.0.1:3000`, with a valid HTTPS
certificate for the API and support for WebSocket upgrades at `/ws/computers`.
For example, a Caddy host configuration (with the frontend on another same-site
host):

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `FRONTEND_ORIGIN=https://app.example.com`. The frontend and API must be
**same-site** for SameSite=Strict cookies: for example, these two HTTPS
subdomains, or the same HTTPS origin with a proxy. Credentialed CORS does not make
cross-site cookies usable. The API checks any supplied Origin for an exact match;
`*`, `null`, a path and a trailing slash are invalid. Do not trust client IPs from
forwarded headers; the current authentication rate limit uses the direct peer,
so users behind a single proxy share the same limit.

## Raspberry Pi

Prefer Raspberry Pi OS 64-bit (`uname -m` returns `aarch64`) and build on the Pi
itself using the production commands above. No separate Dockerfile or
cross-compilation is needed. Use the same LAN connection as the computers you
want to wake with WOL.

With the production configuration, the API listens on `127.0.0.1:3000`. Access
from other devices therefore also requires the HTTPS proxy on the Pi.

## Moving an existing installation

Stop the API on the old host before copying the entire `data/` directory.
Also copy the original `CREDENTIAL_ENCRYPTION_KEY` into the protected
`.env.production` on the new host; do not generate a new key for this.
Update `FRONTEND_ORIGIN` for the new frontend and ensure UID/GID 1000 can write to
the data directory on the new host. Accounts and computers are stored in SQLite
and move with it.

See [operations and backups](operations.md) for recovery and log checks.
