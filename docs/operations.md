# Operations

[Back to the README](../README.md)

## Creating accounts

Accounts can only be created with the local command on the Pi/server; there is no
HTTP registration endpoint. Run it in an interactive terminal with the same
configuration and database as the API. The administrator needs access to the
application configuration and write access to its SQLite database (or permission
to execute commands inside the API container).

For a running Docker deployment:

```sh
docker compose exec api npm run user:create -- operator@example.com
```

Compose allocates a terminal by default; do not add `-T`. The command inherits the
container's environment and uses the mounted database. The API can remain running.
For the development override, use
`docker compose -f compose.yaml -f compose.dev.yaml exec api npm run user:create -- operator@example.com`.

For a direct Node installation, run from the project directory after configuring
`.env` as described in the [development guide](development.md):

```sh
npm run build
npm run user:create -- operator@example.com
```

If the direct Node service uses a different environment file, load that same file:

```sh
node --env-file=.env.production dist/cli/create-user.js operator@example.com
```

The command loads `.env`, with existing environment variables taking precedence,
just like the API. Check `DATABASE_PATH`: a different path creates an account in
a different database. In-memory databases are rejected because another process
would not see the account.

The command asks for the password twice, with no terminal echo. Passwords must be
12–128 characters and are not trimmed. Password arguments, environment-variable
passwords and piped password input are not supported. Only the salted password
hash is stored. Emails are trimmed and lowercased; duplicates fail without
replacing the account or password. Success exits with status 0; invalid input,
cancellation and failures exit with status 1. Account creation does not create a
session: the user must log in normally afterward.

Upgrading removes public registration but preserves existing accounts and
sessions. Review existing accounts if registration was previously exposed to
untrusted clients; removing the endpoint does not revoke earlier access.

## Viewing logs

The API writes one JSON object per line: `info` to stdout, and `warn` and `error`
to stderr. Each line contains `timestamp` (UTC), `level` and `event`.

```sh
# Locally, after yarn build:
node dist/index.js > api.log 2> api-errors.log
# Docker, including recent lines and live updates:
docker compose logs --tail=100 --follow api
# Only the JSON lines, without the Compose prefix:
docker compose logs --no-log-prefix --tail=100 api
```

HTTP requests produce `http_request` with the method, registered route pattern,
final `statusCode` and `durationMs`, including for 401/403/404/413/500 responses.
Unknown routes are named `<unmatched>`; actual IDs and query strings are not
included in HTTP logs. An unexpected 500 also produces `internal_error` with a
fixed reason.

```json
{"timestamp":"2026-10-15T10:00:00.000Z","level":"info","event":"http_request","method":"POST","route":"/computers/:id/off","statusCode":202,"durationMs":12.4}
{"timestamp":"2026-10-15T10:00:01.000Z","level":"error","event":"power_action","action":"off","computerId":"f02c60e1-f7fb-44e8-ae76-cf35487b878f","outcome":"failure","reason":"auth_failed"}
```

Power actions log `on`/`off`, the stored computer ID and success or failure.
The fixed failure reasons are `hostkey_mismatch`, `auth_failed`, `connect_failed`,
`connect_timeout`, `command_timeout`, `command_failed`, `udp_failed`,
`udp_timeout`, `credential_decryption` and `unknown`. HTTP responses remain
generic; technical error details are not sent to clients or written to logs.

`startup`, `shutdown_started` and `shutdown_complete` show the lifecycle;
`shutdown_failed` reports a fixed failure reason. `startup_failed` reports only
known configuration checks or allowed bind/SQLite error codes, with a fixed,
actionable message. Unknown startup errors receive a generic message.

Bodies, headers, cookies, session tokens, email addresses, passwords, SSH keys,
passphrases, encryption keys, raw error messages/stacks and SSH output are not
logged. Full SSH checks produce `ssh_check` with only the computer ID and
`outcome` (`ready`, `auth_failed`, `host_key_mismatch`, `unreachable` or `error`).
Periodic TCP probes and WebSocket frames do not produce logs.
A failing log sink does not affect the HTTP response or power action.

## Backups and recovery

### Authentication limits and bans

`auth_limits` stores active IP and login-name counters and temporary bans. Its
columns are `scope` (`ip` or `login`), `subject_hash` (SHA-256 of the exact direct
IP or trimmed, lowercase login email), `attempts`, `expires_at` (Unix milliseconds)
and `banned` (0 or 1). Passwords and raw identifiers are not stored in this table.
Hashes are pseudonymous identifiers, not encryption; protect the database backup.

Ten attempts are allowed in a sixty-second fixed window; the next attempt starts
a fifteen-minute ban. Banned requests do not move the expiration time. Expired
rows are cleaned on the next auth attempt. The API returns a numeric
`Retry-After` header for persisted limits. No administrative HTTP ban endpoint
is exposed. To clear a specific ban, a database administrator can delete the row
matching its `scope` and `subject_hash`; doing so also resets its counter. There
is no permanent ban history. Restoring an older database also restores the limit
state from that backup.

Behind the documented localhost reverse proxy, all users share the proxy's IP
bucket. Apply per-client limits at the proxy as well. Do not enable arbitrary
`X-Forwarded-For` trust: any future proxy support must restrict trusted peers and
ensure the proxy replaces client-supplied forwarding headers.

### SSH username migration

On first startup after this update, the API trims existing SSH usernames in a
transaction, recording completion in `schema_migrations`. Case, Unicode spelling,
domain prefixes and internal spaces are preserved; there is no lowercasing or
Unicode compatibility folding. Computer IDs, owner IDs, passwords and credential
ciphertext are unchanged. Create and update operations apply the same rule, and
the SSH transport normalizes again before authentication.

If a legacy name becomes empty, exceeds 128 characters after trimming, or contains
embedded control characters, migration fails and rolls back all username changes.
Correct the invalid `computers.ssh_username` value using database administration
before restarting. The API does not silently replace an invalid account name.

### Backup procedure

Stop the API before making a simple file backup, and store the entire SQLite
data directory (including any WAL/SHM files) and **the original encryption key**
separately and securely. With Docker, stop Compose first, then copy/archive the
host directory `data/`, preserving ownership and permissions; store the key from
the protected environment file separately in a safe location. Restore the data
and key together, and check write permissions before restarting the API.
Do not delete the `data/` directory if you want to retain your data. A new key
makes existing credentials unreadable; a lost key cannot be recovered from the
database.

## Files in Git

Source code, tests, `yarn.lock`, Docker configuration, `.env.example` and
documentation belong in Git. Real `.env` files, SQLite data, SSH keys, logs,
dependencies, build output and local agent files are excluded through
`.gitignore`. Keep the database and encryption key safe outside Git, including
when moving to a Raspberry Pi.
