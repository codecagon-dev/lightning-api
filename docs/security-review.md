# Security review — 2026-10-15

Scope: local review of authentication, SQLite storage, computer routes, SSH/WOL,
WebSockets and deployment defaults, plus a dependency advisory audit. No live
network penetration test or review of the separate frontend was performed.

## Addressed in this change

- Public account registration has been removed. `POST /auth/register` returns 404;
  the local `user:create` command requires access to the server configuration and
  database. It prompts for a password without echo and creates no session. This
  also removes the public registration-based account enumeration path. Existing
  accounts and sessions are retained and should be reviewed if public registration
  was previously exposed.

- Authentication rate counters previously lived only in memory and reset on
  restart. SQLite now stores counters and temporary bans, with a transaction
  covering admission across database connections. Login-name limits also cover
  attempts from rotating IPs. See [API behavior](api.md#post-authlogin).
- SSH usernames previously retained surrounding whitespace. Create, update,
  legacy migration and the SSH transport now trim them consistently, preserve
  case and reject empty names and embedded control characters.
- The dependency audit flagged Hono 4.13.5 for
  [GHSA-hxh3-vqpv-xpqv](https://github.com/honojs/hono/security/advisories/GHSA-hxh3-vqpv-xpqv):
  unescaped strings in certain server-side JSX rendering paths. This API does not
  import those rendering paths, so no affected application path was identified.
  Hono is updated to the patched 4.13.7 release. The subsequent Yarn audit reports
  zero known vulnerabilities across 68 dependencies. This does not prove the
  absence of unknown vulnerabilities.

## Remaining findings

### Network access remains broad for provisioned or compromised accounts

The unauthenticated entry point through open registration is closed. However,
any existing account can still register computers with arbitrary valid IPv4
addresses and ports in [`computersRoutes`](../src/routes/computers.ts).
Automatic TCP probes connect to these targets, and WOL sends packets to the
supplied address and port. An authorized or compromised account can therefore
probe services reachable from the API host or generate UDP traffic.
Ownership checks protect other users' records but do not restrict destinations.
SSH host-key pinning and fixed commands protect SSH execution; they do not prevent
TCP probing before authentication.

Only provision trusted users. For further restriction, configure an explicit
allowlist of permitted devices/subnets and ports, ideally with firewall egress
rules. Private LAN destinations cannot simply be blocked because they are the
application's intended targets. See the
[OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
Permitted networks require deployment-specific choices and were not changed here.

### Medium: authenticated resource use has no overall quotas

Computer creation has no per-owner quota. Power actions in
[`computersRoutes`](../src/routes/computers.ts) have no concurrency or frequency
limit, and [`attachComputerWebSockets`](../src/ws/computers.ts) admits unlimited
authenticated connections. An account can grow the database, poll list, active
SSH/UDP work or socket count. Status checks do have a ten-operation concurrency
cap, but this does not cover power actions or bound the total number of computers.
Manual SSH checks can repeatedly bypass the automatic retry latch; this may also
trigger lockouts on the target computer. Add account quotas and per-owner/global
resource limits before permitting untrusted users. SSH rate limiting was explicitly
excluded from this change.

### Medium availability tradeoff: shared proxy IP and targeted login-name bans

The API deliberately uses the direct TCP peer and ignores forwarding headers.
With the documented reverse proxy, everyone shares one IP bucket; one client's
excess requests can block new logins for other clients for
fifteen minutes. An attacker who knows an email can also trigger its login-name
ban from other IPs. Existing sessions remain usable, and blocked requests do not
extend bans. Use proxy-level limits and, if individual client IPs are needed in
the API, explicitly configured trusted proxy addresses with sanitized headers.
The login-name lockout tradeoff is covered in
[OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

## Controls verified in code and tests

Passwords use salted scrypt with bounded concurrency. Only session-token hashes
are persisted. Production cookies use Secure, HttpOnly and SameSite=Strict, and
supplied browser origins must match exactly. Computer queries are parameterized
and owner-scoped. SSH credentials use authenticated encryption tied to computer
and owner IDs; host keys are pinned; shutdown commands are fixed strings.
HTTP errors and logs avoid credential contents. Tests cover these behaviors,
normalization, migration preservation, limit expiration, persistence, shared
connections, capacity, concurrent login admission, removal of public registration,
local account creation, password confirmation and hidden terminal input.
