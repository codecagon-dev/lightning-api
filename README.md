# Lightning API

**Vibe-coded with AI:** this API, its documentation, and much of its test suite
were created with the help of AI coding agents.

Manage your own computers on a local network: wake them with Wake-on-LAN,
shut them down over SSH, and monitor their reachability through a WebSocket.

Built with TypeScript, Hono, and SQLite. The frontend is maintained separately
in [Lightning App](https://github.com/codecagon-dev/lightning-app).

## Features

- Locally provisioned accounts with session cookies and computers scoped to each user.
- Create, edit, and delete computers, with an optional display color.
- Wake-on-LAN using the configured MAC address, broadcast address, and UDP port.
- Shut down Linux and Windows computers over SSH.
- Encrypted SSH credential storage and host key verification.
- TCP reachability and SSH authentication status over HTTP and WebSocket.

A reachable SSH port does not guarantee a successful login, so the API reports
`status` and `sshStatus` separately. Sending a WOL packet does not confirm that
the computer has started.

## Target computer requirements

Before using the API, configure each computer you want to control:

- Enable Wake-on-LAN in the BIOS/UEFI and network adapter settings. Use the
  correct MAC address and LAN broadcast address.
- Install and enable an SSH server, and allow the API host to reach its SSH port.
- Give the SSH user permission to shut down the computer without an interactive
  password prompt. On Linux, allow `sudo -n /sbin/shutdown -h now` through a
  command-specific `NOPASSWD` sudoers rule. On Windows, grant permission to run
  `shutdown.exe /s /t 0`.

SSH login still requires the configured password or private key. The
password-free permission applies to the shutdown command.
See [Preparing computers](docs/computers.md) for host key verification, the
sudoers example, and WOL setup.

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
yarn build
yarn user:create operator@example.com
yarn dev
```

The API runs at `http://localhost:3000`. The example configuration allows a
frontend at `http://localhost:5173`. Keep the encryption key safe: stored SSH
credentials cannot be recovered without the original key.
The account command asks for a password twice without displaying it. Creating
accounts requires access to the Pi/server; public registration is disabled.
See [account management](docs/operations.md#creating-accounts) for Docker commands.

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
