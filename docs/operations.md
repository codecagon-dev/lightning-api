# Operations

[Back to the README](../README.md)

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
