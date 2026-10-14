# Lightning API

Een Hono/TypeScript-API om eigen computers op het lokale netwerk te registreren,
via Wake-on-LAN aan te zetten en via SSH af te sluiten. SQLite bewaart accounts,
sessies en versleutelde SSH-credentials. Er is geen frontend inbegrepen.
Status betekent bereikbaarheid van de SSH-TCP-poort, geen bewijs dat de computer
volledig gestart is of dat SSH-aanmelding lukt.

## Lokaal installeren

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

## HTTPS en browsergebruik

Plaats een host reverse proxy voor `127.0.0.1:3000`, met geldig HTTPS-certificaat
voor de API en ondersteuning voor WebSocket-upgrades op `/ws/computers`.
Bijvoorbeeld een Caddy-hostconfiguratie (frontend op een andere, same-site host):

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Stel `FRONTEND_ORIGIN=https://app.example.com` in. Frontend en API moeten
**same-site** zijn voor SameSite=Strict-cookies: bijvoorbeeld deze twee HTTPS-
subdomeinen, of dezelfde HTTPS-origin met een proxy. Credentialed CORS maakt
cross-site cookies niet bruikbaar. De API controleert een aanwezige Origin exact;
`*`, `null`, een pad en een trailing slash zijn niet geldig. Vertrouw geen
client-IP uit forwarded headers; de huidige authlimiet gebruikt de directe peer,
waardoor gebruikers achter één proxy dezelfde limiet delen.

Voor lokale ontwikkeling: frontend `http://localhost:5173`, API
`http://localhost:3000`, `NODE_ENV=development`. Gebruik dezelfde hostnaam; mix
`localhost` en `127.0.0.1` niet.

```js
await fetch('https://api.example.com/auth/login', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'operator@example.com', password: 'voorbeeld-wachtwoord-123' })
})
const result = await fetch('https://api.example.com/computers', {
  credentials: 'include'
}).then(response => response.json())
const socket = new WebSocket('wss://api.example.com/ws/computers')
socket.onmessage = event => console.log(JSON.parse(event.data))
```

Browsers sturen de HttpOnly-cookie zelf; zet geen token in URL of WebSocket-query.
Niet-browserclients mogen Origin weglaten en gebruiken een cookiejar.

## API-voorbeelden

Onderstaande ontwikkelvoorbeelden gebruiken fictieve credentials. Gebruik in
productie HTTPS en een afgeschermde cookiejar; cookies zijn inloggegevens.
Accountwachtwoorden moeten 12–128 tekens bevatten. JSON-objecten zijn strikt:
onbekende velden worden geweigerd.

```sh
API=http://localhost:3000
umask 077
curl -i -c /tmp/lightning.cookies -H 'Content-Type: application/json' \
  -d '{"email":"operator@example.com","password":"voorbeeld-wachtwoord-123"}' "$API/auth/register"
curl -i -b /tmp/lightning.cookies -c /tmp/lightning.cookies \
  -H 'Content-Type: application/json' \
  -d '{"email":"operator@example.com","password":"voorbeeld-wachtwoord-123"}' "$API/auth/login"
curl -b /tmp/lightning.cookies "$API/auth/me"
# Vervang de voorbeeldfingerprint door de vertrouwd gecontroleerde hostfingerprint.
curl -i -b /tmp/lightning.cookies -H 'Content-Type: application/json' \
  -d '{"name":"Werkkamer","os":"linux","ipAddress":"192.168.1.20","macAddress":"aa:bb:cc:dd:ee:ff","broadcastAddress":"192.168.1.255","sshPort":22,"wolPort":9,"sshUsername":"lightning","sshHostKeyFingerprint":"SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","sshPassword":"fictief-ssh-wachtwoord"}' \
  "$API/computers"
curl -b /tmp/lightning.cookies "$API/computers"
# COMPUTER_ID is de id uit create/list; on/off voeren echte hardwareacties uit.
COMPUTER_ID=vervang-door-computer-id
curl -i -X POST -b /tmp/lightning.cookies "$API/computers/$COMPUTER_ID/on"
curl -i -X POST -b /tmp/lightning.cookies "$API/computers/$COMPUTER_ID/off"
curl -i -X POST -b /tmp/lightning.cookies -c /tmp/lightning.cookies "$API/auth/logout"
rm /tmp/lightning.cookies
```

Registreren geeft 201, login/me/list 200, computerregistratie 201 en on/off 202
`{"ok":true}` na acceptatie door de adapter. Logout geeft 204 zonder body en sluit
bijbehorende WebSockets. WOL-acceptatie bevestigt het verzenden, niet het starten
van de computer. Geen sessie geeft 401; ontbrekende of andermans computer geeft
404; transportfouten geven 502 of 504 met een vaste foutmelding. JSON-fouten geven
400, verkeerde Origin 403, te grote bodies 413, verkeerd mediatype 415 en een
bereikte authlimiet 429.

Computerregistratie vereist name, ipAddress (IPv4), macAddress, broadcastAddress
(IPv4), sshUsername, sshHostKeyFingerprint en precies één van sshPassword of
sshPrivateKey. Bij een private key mag sshPrivateKeyPassphrase worden toegevoegd.
`os` is `linux` (standaard) of `windows`, `sshPort` standaard 22, `wolPort` standaard
9. Credentials/ciphertext/eigenaar worden nooit teruggegeven. Er zijn geen update-
of verwijderroutes. IP/SSH-poorten moeten vanaf de API-host bereikbaar zijn.

WebSocket `/ws/computers` gebruikt dezelfde sessie en exacte browser-Origin.
Een verbinding krijgt een eigenaargebonden snapshot; registratie stuurt opnieuw
een snapshot. Statusovergangen sturen:

```json
{"type":"snapshot","computers":[]}
{"type":"status","computerId":"voorbeeld-id","status":"online","checkedAt":"2026-10-14T12:00:00.000Z"}
```

Snapshots bevatten dezelfde publieke computervelden als de lijst, met status
`unknown`, `online` of `offline`, en `checkedAt` (ISO-tijd of aanvankelijk null).
Polling begint direct, draait elke tien seconden met maximaal tien probes en geen
overlap. Logout/verlopen sessies sluiten bestaande verbindingen. Heartbeats en
bufferlimieten sluiten stille of trage clients; reconnect met een geldige sessie
levert een nieuw snapshot. Een niet-browserclient mag Origin weglaten.

## Computers voorbereiden

Controleer de SSH-hostfingerprint via een vertrouwde console of een reeds
geverifieerde beheerverbinding op de computer zelf, bijvoorbeeld op Linux:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Neem het `SHA256:...`-veld zonder afsluitende `=` over. Controleer dat de server
die sleutel aanbiedt. `ssh-keyscan` zonder onafhankelijke controle is geen
vertrouwde bron. Bij een gewijzigde of onbekende key wordt geen shutdown uitgevoerd.

Op Linux moet de toegewezen SSH-gebruiker uitsluitend de vaste shutdown-opdracht
zonder wachtwoord mogen uitvoeren. Maak via `sudo visudo -f
/etc/sudoers.d/lightning` bijvoorbeeld deze regel (pas alleen de gebruiker aan):

```sudoers
lightning ALL=(root) NOPASSWD: /sbin/shutdown -h now
```

De API voert exact `sudo -n /sbin/shutdown -h now` uit. Controleer lokaal dat dit
pad bestaat; geef geen brede `NOPASSWD: ALL` of willekeurige shellrechten.
Test het werkelijk afsluiten uitsluitend tijdens een afgesproken onderhoudsmoment.

Op Windows: installeer/configureer OpenSSH Server, start `sshd`, open de gekozen
SSH-poort in de firewall en geef de SSH-gebruiker de nodige afsluitrechten.
De opdracht is exact `shutdown.exe /s /t 0`. Controleer de aangeboden hostkey via
een vertrouwde console met `ssh-keygen -lf` op de publieke hostsleutel in
`C:\ProgramData\ssh`. Valideer rechten en gedrag op de doelcomputer.

Voor WOL: schakel wake via LAN/PCIe in BIOS/UEFI en in de netwerkadapterdriver in.
Controleer standbyvoeding, bekabelde LAN-ondersteuning, MAC-adres en subnet-
broadcastadres. Switches, firewalls, slaapstanden en Windows Fast Startup kunnen
WOL verhinderen. Docker-host en computers horen op het computer-LAN; de router
moet broadcast doorlaten als ze niet op hetzelfde subnet staan. Een TCP-status-
test bewijst geen werkende WOL of shutdown: beide vereisen echte hardwarevalidatie.

## Docker op een Linux-server

Docker Engine en de Compose-plugin moeten op de server aanwezig zijn. De
multi-stage image installeert met de lockfile, compileert TypeScript en draait als
onbevoorrechte `node`-gebruiker. Het named volume bewaart `/app/data`; een nieuw
volume neemt de node-eigenaar van deze directory over. Bij hergebruik moet de
volume-eigenaar UID/GID 1000 kunnen schrijven. Gebruik een eigen envbestand:

```sh
cp .env.example .env.production
chmod 600 .env.production
# Vul NODE_ENV=production, FRONTEND_ORIGIN=https://app.example.com en de sleutel in.
# Genereer de sleutel eenmaal met het Node-commando hierboven.
docker compose config --quiet
docker compose build
docker compose up -d
docker compose logs --tail=20 api
curl -i http://127.0.0.1:3000/auth/me   # Zonder cookie: 401 JSON
# Controleer daarna via HTTPS dezelfde API-voorbeelden en WSS in de browser.
docker compose stop
# Herstart en controleer dat geregistreerde computers behouden blijven:
docker compose up -d
```

`network_mode: host` is hier bedoeld voor Linux: het deelt de hostnetwerkstack,
vermindert netwerkisolatie en maakt LAN-broadcast mogelijk. Er zijn geen `ports`-
mappings. De API bindt op host-localhost en de HTTPS-proxy draait op de host.
De Compose-omgeving forceert productie, localhost, poort 3000 en de volume-DB.
`restart: unless-stopped` herstart de service; `init: true` helpt signalen en
procesopruiming. Secrets worden pas via `.env.production` geïnjecteerd en niet in
de image gebakken. Publiceer `docker compose config`-output met secrets niet;
gebruik `--quiet`. `.dockerignore` sluit secrets, lokale data en configuratie uit.

## Back-up en verificatie

Stop de API vóór een eenvoudige bestandsback-up en bewaar de volledige
SQLite-datadirectory (inclusief eventuele WAL/SHM-bestanden) en **de oorspronkelijke
encryptiesleutel** afzonderlijk en beschermd. Bij Docker: stop eerst Compose en
kopieer/archiveer het named volume met behoud van eigenaar en rechten; zet de
sleutel uit het afgeschermde envbestand veilig apart. Herstel data en sleutel
samen en controleer de schrijfrechten voordat de API opnieuw start.
Gebruik `docker compose down -v` niet wanneer je data wilt behouden. Een nieuwe
sleutel maakt bestaande credentials onleesbaar; een verloren sleutel kan niet
uit de database worden teruggehaald.

De workspace-tests gebruiken echte SQLite/auth/Hono en echte WebSocket-framing
via geheugenstreams, met vervangende power/probe-adapters. De lokale sandbox
weigert luisterende sockets (`EPERM`); een gebonden HTTP/WSS-smoketest is hier
niet uitgevoerd. De Docker-client is beschikbaar, maar toegang tot de daemon
is geweigerd en de Compose-plugin ontbreekt. Imagebuild, containers, Compose-CLI,
reverse proxy, Node 24-runtime en echte hardware zijn hier **niet uitgevoerd**.
Bovenstaande servercommando's zijn de nog uit te voeren smokechecks. Dependency-
installatie met de lockfile is offline gecontroleerd zonder optionele pakketten
of scripts; een gewone schone installatie/build vereist een server met registry-
toegang. De bestaande lokale dependencies worden gebruikt voor build en tests.
