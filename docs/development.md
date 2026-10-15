# Ontwikkeling en configuratie

[Terug naar de README](../README.md)

## Lokaal met Node.js

Gebruik Node.js 24 of hoger en Yarn Classic 1.22. De Docker-images gebruiken Node
24 Debian Bookworm. `node:sqlite` is ingebouwd; SQLite hoeft niet apart geïnstalleerd
te worden. SSH gebruikt `ssh2`; optionele native optimalisaties zijn niet nodig.

```sh
yarn install --frozen-lockfile
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
# Zet de gegenereerde sleutel in CREDENTIAL_ENCRYPTION_KEY in .env.
chmod 600 .env
yarn build
yarn start
# Tijdens ontwikkeling: yarn dev
# Tests: yarn test
```

De sleutel is verplicht: exact 32 willekeurige bytes in canonieke base64.
Bewaar hem buiten de database en houd hem geheim. De server leest `.env` bij
opstarten; al ingestelde procesvariabelen hebben voorrang. Importeren van de
runtime start geen luisterende server. SIGINT/SIGTERM stopt polling, sluit
WebSockets en HTTP, en sluit daarna SQLite. Lopende HTTP-verzoeken krijgen maximaal
tien seconden; polling wacht op de actieve ronde.

| Variabele | Waarde / betekenis |
| --- | --- |
| `NODE_ENV` | `production` (standaard) of `development` |
| `HOST` | `127.0.0.1` (standaard); bind achter de HTTPS-proxy lokaal |
| `PORT` | `3000` (standaard), geheel getal 1–65535 |
| `DATABASE_PATH` | `./data/lightning.sqlite` (standaard); Docker: `/app/data/lightning.sqlite` |
| `FRONTEND_ORIGIN` | Exacte origin zonder pad of slash; productie vereist HTTPS; ontwikkeling standaard `http://localhost:5173` |
| `CREDENTIAL_ENCRYPTION_KEY` | Verplichte base64-sleutel; nooit vervangen zonder credentialmigratie |

De sessiecookie `lightning_session` is HttpOnly, SameSite=Strict en in productie
Secure, met een geldigheid van zeven dagen. De database bevat alleen de tokenhash.
Credentials zijn AES-256-GCM versleuteld en gebonden aan computer en eigenaar.

## Browsergebruik

Gebruik lokaal `http://localhost:5173` voor de frontend en `http://localhost:3000`
voor de API, met `NODE_ENV=development`. Gebruik dezelfde hostnaam: mix `localhost`
en `127.0.0.1` niet. Stuur bij fetch-aanvragen `credentials: 'include'` mee.
De API levert zelf geen frontend.

```js
await fetch('http://localhost:3000/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'operator@example.com', password: 'voorbeeld-wachtwoord-123' })
})
const socket = new WebSocket('ws://localhost:3000/ws/computers')
socket.onmessage = event => console.log(JSON.parse(event.data))
```

De browser verstuurt de HttpOnly-cookie automatisch. Zet geen sessietoken in een
URL. Niet-browserclients gebruiken een cookiejar; zie de [API-referentie](api.md).

## Lokaal met Docker

Zie [Docker en deployment](deployment.md#lokaal-testen-met-http) voor de
development-override. Die gebruikt `.env.production` voor de encryptiesleutel en
bestaande database, maar zet de runtime expliciet op development.

## Controles

```sh
yarn test
yarn build
```

Tests gebruiken SQLite, Hono, authenticatie en WebSocket-framing via
geheugenstreams. TCP-, SSH- en WOL-acties worden vervangen door testadapters.
Controleer WOL en afsluiten daarnaast op echte hardware.
