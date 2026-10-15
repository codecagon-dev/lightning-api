# API reference

This reference describes Lightning API's current HTTP endpoints and WebSocket. There is no `/api` prefix. Use HTTPS and WSS in production. The default local address is `http://localhost:3000`.

## General conventions

- Requests containing account or computer data require `Content-Type: application/json`.
- JSON objects for registration/login, computer registration, and computer updates are strict: unknown fields return 400.
- The maximum HTTP body size is 64 KiB. The combined JSON containing SSH credentials must not exceed 32 KiB, including UTF-8 encoding and JSON escaping.
- Authentication uses the `lightning_session` cookie. Registration and login set this cookie; the response body contains no token.
- The cookie is HttpOnly, SameSite=Strict, valid for seven days, and Secure in production. The frontend and API must be same-site for browser use. Use `credentials: 'include'` for cross-origin fetch requests.
- If present, `Origin` must exactly match `FRONTEND_ORIGIN`. Non-browser clients may omit Origin. CORS preflights use `OPTIONS` and return 204 for an allowed Origin.
- Computer data and actions are available only to the owner. An unknown computer and a computer belonging to someone else both return 404.
- HTTP errors have the form `{"error":"message"}`. SSH credentials, password hashes, and session tokens are never returned.

## Endpoint overview

| Method | Path | Authentication | Success |
| --- | --- | --- | --- |
| POST | `/auth/register` | No | 201, user and session cookie |
| POST | `/auth/login` | No | 200, user and session cookie |
| POST | `/auth/logout` | Optional | 204, empty body; session revoked |
| GET | `/auth/me` | Yes | 200, current user |
| POST | `/computers` | Yes | 201, created computer |
| GET | `/computers` | Yes | 200, own computers with status |
| PATCH | `/computers/:id` | Yes | 200, updated computer |
| DELETE | `/computers/:id` | Yes | 204, registration and credentials deleted; empty body |
| POST | `/computers/:id/on` | Yes | 202, WOL packet sent |
| POST | `/computers/:id/check-ssh` | Yes | 200, TCP and SSH diagnostics |
| POST | `/computers/:id/off` | Yes | 202, SSH shutdown completed successfully |
| GET (WebSocket upgrade) | `/ws/computers` | Yes | 101, status connection |

There are currently no password reset or admin endpoints.

## Accounts

### POST /auth/register

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `email` | string | Yes | Valid email address, at most 254 characters after trimming; converted to lowercase |
| `password` | string | Yes | 12–128 characters; not trimmed |

```json
{"email":"operator@example.com","password":"example-password-123"}
```

Success: **201** and a `Set-Cookie` header. Registration logs the user in immediately.

```json
{"user":{"id":"550e8400-e29b-41d4-a716-446655440000","email":"operator@example.com"}}
```

Errors: 400 for invalid fields/JSON, 409 `Email already registered`, 415 for an incorrect content type, 429 for too many attempts or concurrent password computations. The general errors listed below are also possible.

### POST /auth/login

Uses the same request fields and validation as registration. Success: **200**, the same user response, and a new session cookie. An incorrect password or unknown account returns **401** with `{"error":"Invalid email or password"}`. Error codes 400, 415, and 429 are also possible.

Registration and login share a limit of ten attempts per minute per direct client IP. Users behind a reverse proxy may therefore share the same limit. Forwarded IP headers are not trusted.

### POST /auth/logout

No request body is needed. Revokes the current session, removes the cookie, and closes that session's WebSockets. Success: **204 without a body**, even if there was no valid session.

### GET /auth/me

No request body. Success: **200** with the same `{"user":{"id":"...","email":"..."}}` structure. Without a valid session: **401** with `{"error":"Authentication required"}`.

## Computers

### POST /computers

| Field | Type | Required | Default / rules |
| --- | --- | --- | --- |
| `name` | string | Yes | Not empty or whitespace-only; at most 100 characters |
| `color` | string or null | No | `null`; exactly `#RRGGBB`, case-insensitive, stored in lowercase |
| `os` | string | No | `linux` (default) or `windows` |
| `ipAddress` | string | Yes | Valid IPv4 address; no hostname or IPv6 |
| `macAddress` | string | Yes | Six hexadecimal octets, consistently separated by `:` or `-`; stored in lowercase with `:` |
| `broadcastAddress` | string | Yes | Valid IPv4 broadcast address for the LAN |
| `sshPort` | integer | No | 22; range 1–65535 |
| `wolPort` | integer | No | 9; range 1–65535 |
| `sshUsername` | string | Yes | Not empty or whitespace-only; at most 128 characters |
| `sshHostKeyFingerprint` | string | Yes | Canonical OpenSSH SHA256 fingerprint: `SHA256:` followed by 43 base64 characters, without a trailing `=` |
| `sshPassword` | string | One of two | Not empty; exactly one of password or private key |
| `sshPrivateKey` | string | One of two | Private key contents, including any newlines; exactly one of key or password |
| `sshPrivateKeyPassphrase` | string | No | Only together with `sshPrivateKey`; an empty string is allowed |

Verify the host fingerprint through a trusted console on the computer. Do not supply an owner, ID, status, date, or shutdown command: these fields are not accepted.

Example with fictional data; replace the fingerprint with the real fingerprint verified through a trusted channel:

```json
{
  "name": "Home office",
  "color": "#3366cc",
  "os": "linux",
  "ipAddress": "192.168.1.20",
  "macAddress": "aa:bb:cc:dd:ee:ff",
  "broadcastAddress": "192.168.1.255",
  "sshPort": 22,
  "wolPort": 9,
  "sshUsername": "lightning",
  "sshHostKeyFingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "sshPassword": "fictional-ssh-password"
}
```

Success: **201** with `{"computer": Computer}`. `Computer` has the public fields below. The initial status is `unknown` with `checkedAt: null`. Errors: 400 `Invalid computer input`, 401 without a session, or 415 without a JSON content type, in addition to general errors.

### Public computer response

```json
{
  "computer": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "Home office",
    "color": "#3366cc",
    "os": "linux",
    "ipAddress": "192.168.1.20",
    "macAddress": "aa:bb:cc:dd:ee:ff",
    "broadcastAddress": "192.168.1.255",
    "sshPort": 22,
    "wolPort": 9,
    "sshUsername": "lightning",
    "sshHostKeyFingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "createdAt": "2026-10-15T12:00:00.000Z",
    "status": "unknown",
    "checkedAt": null,
    "sshStatus": "unknown",
    "sshCheckedAt": null
  }
}
```

`color` is always present in the response: a lowercase hex color or `null`. Omitting it or explicitly setting it to `null` means no color; no default color is chosen. Existing computers receive `null` during the automatic database migration.

`id` is a server-generated UUID. `createdAt` and a non-null `checkedAt` are ISO dates. Status is `unknown`, `online`, or `offline`. SSH passwords, private keys, passphrases, ciphertext, and owner IDs are always omitted.

### GET /computers

No request body or query parameters are needed. Success: **200** with `{"computers":[Computer]}`. An empty list is `{"computers":[]}`. All computers belong to the logged-in user. Each computer has the public fields above and the latest status/check time. Without a session: **401**.

### PATCH /computers/:id

Updates a computer owned by the user using a non-empty JSON object. Every field from `POST /computers` can be updated individually, with the same validation and normalization. Omitted fields retain their current values; registration defaults are not reapplied. `color: null` removes the color. Other required computer fields cannot be `null`. Unknown fields and server fields such as `id`, `ownerId`, `createdAt`, status, and ciphertext are rejected.

```json
{"name":"New name","color":null,"sshPort":2222}
```

Without credential fields, the encrypted credential contents remain exactly as stored, even if they cannot be decrypted. `sshPassword` replaces all previous key/passphrase data. `sshPrivateKey` replaces all previous credentials; supply any passphrase again, otherwise it is removed. A password together with a key, or a password together with a passphrase, is invalid.

Updating only `sshPrivateKeyPassphrase` is possible for an existing, readable private key. A string replaces the passphrase; `null` removes it. With a new key, any passphrase must be a string (or omitted). The combined new credential JSON remains limited to 32 KiB.

Success: **200** with `{"computer": Computer}`, without secrets. The ID, owner, and creation date are preserved. Every successful update resets TCP and SSH status to `unknown`, sets check times to `null`, and clears the automatic SSH login block. All of the owner's WebSockets receive an updated snapshot. The next poll uses the updated data. Results from earlier checks are ignored; those checks continue to count toward the capacity limit until they finish. A manual check while such an old check is running returns 503 and can be requested again afterward.

Errors: **400** for an empty patch, invalid fields/JSON, an invalid credential combination, or a passphrase update without a readable key; **401** without a session; **404** for unknown computers/computers belonging to someone else, or deletion while the body is being read; **415** without a JSON content type. General errors are also possible.

### DELETE /computers/:id

No request body is needed. Deletes only the registration and stored SSH credentials of a computer owned by the user. The physical PC is unaffected: this does not perform a WOL or shutdown action. There is no recovery endpoint.

Success: **204 without a body**. Without a valid session: **401** `Authentication required`. An unknown, already deleted, or someone else's computer always returns **404** `Not found`. General errors such as 403 for an incorrect Origin are also possible.

All of the owner's WebSockets receive an updated snapshot without the deleted computer. Running status checks no longer produce status messages for that computer afterward.

### SSH status and automatic checks

Public computers, snapshots, and status messages always contain `sshStatus` and
`sshCheckedAt`. The latter is an ISO timestamp of the last full SSH check or
`null`; TCP probes do not change this time. These fields are transient, with no
new database columns.

| `sshStatus` | Meaning |
| --- | --- |
| `unknown` | No current SSH check yet; also after returning online during the cooldown |
| `ready` | The stored SHA256 host key is trusted and the stored credentials log in successfully |
| `auth_failed` | SSH authentication rejected |
| `host_key_mismatch` | The presented host key differs from the stored fingerprint |
| `unreachable` | TCP offline or SSH connection failed/disconnected/timed out |
| `error` | Internal check error or stored credentials cannot be decrypted |

The API checks SSH automatically only when TCP status is `online`,
at most once every sixty seconds. The existing TCP check continues to run every ten
seconds. After `auth_failed`, `host_key_mismatch`, or unreadable credentials,
automatic attempts are blocked until a manual full SSH check or a computer update. This
block survives offline/online transitions, but not a process restart: another attempt
may occur after a restart. Offline TCP invalidates previous SSH readiness while
preserving the last `sshCheckedAt`. Returning online during the cooldown results in
`unknown` until the next full check.

Each SSH check opens a brief connection, validates the host key, authenticates using
the stored password or private key and any passphrase, and closes
immediately. No session remains logged in. The check does not open a shell or perform
exec, sudo, SFTP, or shutdown operations. `ready` does not prove shutdown permissions.

### POST /computers/:id/check-ssh

Requires a valid session and a computer owned by the user. Send an **empty request body**
(not `{}`). Performs a fresh TCP probe and, only if `online`, a full
SSH check. A manual attempt may bypass the automatic cooldown and block.
If TCP is offline or unknown, no credentials are offered; an
existing login block remains in place.

Success: **200**, even when the completed diagnostic check fails:

```json
{"computerId":"550e8400-e29b-41d4-a716-446655440001","status":"online","checkedAt":"2026-10-15T12:00:10.000Z","sshStatus":"auth_failed","sshCheckedAt":"2026-10-15T12:00:10.000Z"}
```

Errors: 400 for a non-empty body, 401 without a session, 404 for unknown computers/computers
belonging to someone else, or deletion during the check, 429 at full capacity, 503 when
the checker is unavailable, an old check is still running after an update, or shutdown prevents new checks. No
raw errors or credentials appear in the response.

Concurrent manual/automatic checks for the same computer share a single
attempt. The global limit is ten concurrent computer checks; excess work
is rejected or skipped without an unbounded queue. Shutdown waits for
running checks and starts no new ones. A changed TCP **or** SSH status
appears immediately in a WebSocket status message for the owner; unchanged
statuses are not pushed again. GET does return fresh check times.

### POST /computers/:id/on

Replace `:id` with the stored computer ID. No request body is needed: the address, MAC, and port come from the database. Sends a UDP Wake-on-LAN packet to the stored broadcast address and WOL port.

Success: **202** with `{"ok":true}`. This confirms transmission, not that the PC has actually started. Errors: 401, 404, 502, or 504, in addition to general errors.

### POST /computers/:id/off

Replace `:id` with the stored computer ID. No request body is needed. Verifies the SSH host key, logs in with the stored credentials, and runs the fixed command for the OS:

- Linux: `sudo -n /sbin/shutdown -h now`.
- Windows: `shutdown.exe /s /t 0`.

Success: **202** with `{"ok":true}` after the SSH command completes successfully. A lost connection without a confirmed exit code of 0 counts as an error, even if the computer is shutting down in the meantime. Errors: 401, 404, 502, or 504, in addition to general errors. This endpoint actually shuts down the computer.

## WebSocket /ws/computers

Use `wss://<api-host>/ws/computers` with the session cookie. Browsers send it automatically. The URL must contain exactly this path; extra query parameters or a trailing slash are rejected. A token in the URL does not authenticate. No client messages are needed to receive updates.

After a successful **101** upgrade, a snapshot follows with the same public computer objects as `GET /computers`:

```json
{"type":"snapshot","computers":[]}
```

After computer registration, updates, and deletion, another snapshot is sent to all of the owner's connections. Snapshots also contain `color` (hex color or `null`). A deleted computer disappears from the snapshot; running probes send no subsequent status for that ID. A status change produces:

```json
{"type":"status","computerId":"550e8400-e29b-41d4-a716-446655440001","status":"online","checkedAt":"2026-10-15T12:00:10.000Z","sshStatus":"ready","sshCheckedAt":"2026-10-15T12:00:10.000Z"}
```

The server checks the SSH TCP port every ten seconds. `online` means reachable, `offline` means unreachable, and `unknown` means not yet checked or an unexpected internal check error. This does not prove the physical power state or successful SSH login. Unchanged statuses are not pushed again; `GET /computers` does return the latest check time.

Logout and session expiry terminate the connection. The server uses ping/pong and terminates silent connections and clients with more than 1 MiB of outgoing buffered data. Incoming messages are limited to 64 KiB.

Errors before the upgrade use an empty HTTP body: 400 for an invalid handshake, 401 without a valid session, 403 for an incorrect Origin, 404 for an incorrect path, and 500 for an internal authentication error. The `ws` library can also reject handshakes that violate the protocol itself, including with 400 or 405. After the upgrade, connection problems are WebSocket events, not JSON HTTP responses; the application may terminate the connection abruptly.

## General HTTP errors

| Status | Possible message / meaning |
| --- | --- |
| 400 | `Empty body required`, `Invalid JSON body`, `Invalid request fields`, `Invalid email or password format`, or `Invalid computer input` |
| 401 | `Authentication required`, or `Invalid email or password` during login |
| 403 | `Origin not allowed` |
| 404 | `Not found`; unknown route or unknown computer/computer belonging to someone else |
| 409 | `Email already registered` |
| 413 | `Request body too large` |
| 415 | `JSON body required` |
| 429 | `Too many requests` |
| 500 | `Internal server error`; details are not exposed |
| 502 | `Power action failed`; for example, SSH login, host key verification, command execution, or WOL transmission failed |
| 503 | `SSH check unavailable`; checker unavailable or API shutting down |
| 504 | `Power action timed out` |

For example, an error response looks like this:

```json
{"error":"Authentication required"}
```

See [development](development.md) for local setup and configuration,
[deployment](deployment.md) for Docker and HTTPS, and
[preparing computers](computers.md) for SSH permissions and WOL settings.
