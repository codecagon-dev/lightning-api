# Lightning API

**Vibe-coded with AI:** this API, its documentation, and much of its test suite
were created with the help of AI coding agents.

Manage your own computers on a local network: wake them with Wake-on-LAN,
shut them down over SSH, and monitor their reachability through a WebSocket.

Built with TypeScript, Hono, and SQLite. No frontend is included.

## Features

- Accounts with session cookies and computers scoped to each user.
- Create, edit, and delete computers, with an optional display color.
- Wake-on-LAN using the configured MAC address, broadcast address, and UDP port.
- Shut down Linux and Windows computers over SSH.
- Encrypted SSH credential storage and host key verification.
- TCP reachability and SSH authentication status over HTTP and WebSocket.

A reachable SSH port does not guarantee a successful login, so the API reports
`status` and `sshStatus` separately. Sending a WOL packet does not confirm that
the computer has started.

## Quick start

Requires Node.js 24 or later and Yarn Classic 1.22.

```sh
yarn install --frozen-lockfile
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set `CREDENTIAL_ENCRYPTION_KEY` in `.env` to the generated key, then start:

```sh
chmod 600 .env
yarn dev
```

The API runs at `http://localhost:3000`. The example configuration allows a
frontend at `http://localhost:5173`. Keep the encryption key safe: stored SSH
credentials cannot be recovered without the original key.

For Docker, a Linux server, or a Raspberry Pi, see the
[deployment guide](docs/deployment.md). Production uses HTTPS and a reverse proxy.
Prepare the target computers before using WOL or SSH.

## Documentation

| Topic | Guide |
| --- | --- |
| Endpoints, request fields, responses, and WebSocket | [API reference](docs/api.md) |
| Local development, configuration, and browser clients | [Development](docs/development.md) |
| Docker, HTTPS, Raspberry Pi, and migration | [Deployment](docs/deployment.md) |
| WOL, SSH host keys, and shutdown permissions | [Preparing computers](docs/computers.md) |
| Logs, backups, and repository contents | [Operations](docs/operations.md) |

## Development

```sh
yarn test
yarn build
```

Tests replace external TCP, SSH, and WOL operations with test adapters. Verify
network connectivity and hardware actions on your own installation as well.

## License

Available under the [MIT License](LICENSE).
