# Lightning API

Zie [de API-referentie](docs/api.md) voor alle endpoints, requestvelden, responses en foutcodes.

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
# Verwijdert alleen registratie en credentials, zonder de fysieke pc te bedienen.
curl -i -X DELETE -b /tmp/lightning.cookies "$API/computers/$COMPUTER_ID"
curl -i -X POST -b /tmp/lightning.cookies -c /tmp/lightning.cookies "$API/auth/logout"
rm /tmp/lightning.cookies
```

Registreren geeft 201, login/me/list 200, computerregistratie 201 en on/off 202
`{"ok":true}` na acceptatie door de adapter. Verwijderen geeft 204 zonder body.
Logout geeft 204 zonder body en sluit
bijbehorende WebSockets. WOL-acceptatie bevestigt het verzenden, niet het starten
van de computer. Geen sessie geeft 401; ontbrekende of andermans computer geeft
404; transportfouten geven 502 of 504 met een vaste foutmelding. JSON-fouten geven
400, verkeerde Origin 403, te grote bodies 413, verkeerd mediatype 415 en een
bereikte authlimiet 429.

Computerregistratie vereist name, ipAddress (IPv4), macAddress, broadcastAddress
(IPv4), sshUsername, sshHostKeyFingerprint en precies één van sshPassword of
sshPrivateKey. Bij een private key mag sshPrivateKeyPassphrase worden toegevoegd.
`os` is `linux` (standaard) of `windows`, `sshPort` standaard 22, `wolPort` standaard
9. `color` is optioneel: `#RRGGBB` wordt naar kleine letters omgezet; weglaten of
`null` geeft geen kleur (`color: null` in responses). Bestaande registraties krijgen
bij migratie eveneens `null`. Credentials/ciphertext/eigenaar worden nooit
teruggegeven. Er zijn geen updateroutes. IP/SSH-poorten moeten vanaf de API-host bereikbaar zijn.

WebSocket `/ws/computers` gebruikt dezelfde sessie en exacte browser-Origin.
Een verbinding krijgt een eigenaargebonden snapshot; registratie en verwijdering sturen opnieuw
een snapshot. Verwijderde IDs krijgen geen latere statusupdates. Statusovergangen sturen:

```json
{"type":"snapshot","computers":[]}
{"type":"status","computerId":"voorbeeld-id","status":"online","checkedAt":"2026-10-14T12:00:00.000Z","sshStatus":"ready","sshCheckedAt":"2026-10-14T12:00:00.000Z"}
```

Snapshots bevatten dezelfde publieke computervelden als de lijst, inclusief
`color` (hexkleur of null), met status
`unknown`, `online` of `offline`, en `checkedAt` (ISO-tijd of aanvankelijk null).
Polling begint direct, draait elke tien seconden met maximaal tien probes en geen
overlap. Logout/verlopen sessies sluiten bestaande verbindingen. Heartbeats en
bufferlimieten sluiten stille of trage clients; reconnect met een geldige sessie
levert een nieuw snapshot. Een niet-browserclient mag Origin weglaten.

### Echte SSH-controle

Naast TCP-bereikbaarheid bevat iedere computer `sshStatus` en `sshCheckedAt`
(ISO-tijd van de laatste volledige SSH-controle, aanvankelijk `null`). De mogelijke
waarden zijn `unknown` (nog geen actuele controle), `ready` (vertrouwde hostkey en
succesvolle login), `auth_failed` (login geweigerd), `host_key_mismatch` (hostkey
wijkt af), `unreachable` (TCP/SSH niet bereikbaar) en `error` (interne controlefout
of onleesbare opgeslagen credentials). Deze velden zijn tijdelijk procesgeheugen,
geen databasekolommen.

Iedere controle opent een korte SSH-verbinding, controleert de opgeslagen SHA256-
hostkey, logt in met het opgeslagen wachtwoord of de private key/passphrase en
sluit direct. Er blijven geen SSH-sessies ingelogd. Er wordt geen shell, opdracht,
sudo, SFTP of shutdown uitgevoerd. `ready` bewijst dus geen shutdownrechten.

TCP wordt iedere tien seconden gecontroleerd. Alleen bij `online` volgt automatisch
een SSH-controle, hoogstens eenmaal per zestig seconden. Na geweigerde authenticatie,
een afwijkende hostkey of onleesbare credentials stoppen automatische loginpogingen
tot een handmatige volledige controle. Offline/online worden heft die blokkade niet
op. De blokkade en resultaten leven alleen in dit proces: na een herstart kan de API
opnieuw eenmaal proberen. Offline TCP maakt een oude `ready` ongeldig en kan
`unreachable` tonen; na terugkeer tijdens de wachttijd blijft de SSH-status `unknown`.
TCP-controles veranderen `sshCheckedAt` niet.

`POST /computers/:id/check-ssh` met sessiecookie en een lege body controleert direct
TCP en bij `online` ook SSH, ongeacht wachttijd of blokkade. De response is **200**
met `{computerId,status,checkedAt,sshStatus,sshCheckedAt}`, ook bij een afgeronde
mislukte diagnose. Zonder sessie volgt 401; onbekende/andermans/verwijderde computers
geven 404. Een niet-lege body geeft 400, volle capaciteit 429 en een niet-beschikbare
checker 503. Een handmatige controle terwijl TCP offline is voert geen login uit en
heft een bestaande loginblokkade niet op. Gelijke gelijktijdige controles delen één
poging; maximaal tien computercontroles kunnen tegelijk lopen. Afsluiten wacht op
lopende controles en start geen nieuwe SSH-verbindingen. SSH-statuswijzigingen
verschijnen direct als owner-only WebSocket-statusbericht; ongewijzigde statussen
blijven stil en GET geeft wel actuele controletijden.

Computers wijzigen kan met `PATCH /computers/:id` en een niet-leeg JSON-object,
bijvoorbeeld `{"name":"Werkkamer","color":null}`. Weggelaten velden blijven behouden;
alle registratievelden zijn wijzigbaar. Een nieuw SSH-wachtwoord of een nieuwe key
vervangt de volledige oude credentialset. Alleen een passphrase wijzigen kan bij
een bestaande private key; `null` verwijdert die passphrase. Succes geeft 200 met
de publieke computer en een vernieuwd WebSocket-snapshot voor de eigenaar.
Elke wijziging reset TCP/SSH-status, controletijden en de SSH-loginblokkade;
oude controles worden genegeerd en de volgende poll gebruikt de nieuwe gegevens.
Zie [PATCH in de API-referentie](docs/api.md#patch-computersid) voor alle regels.

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

### Lokaal testen met HTTP

Voor Docker op je eigen pc is er een expliciete development-override:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
docker compose -f compose.yaml -f compose.dev.yaml logs -f --tail=50 api
```

Deze gebruikt `NODE_ENV=development` en standaard `FRONTEND_ORIGIN=http://localhost:5173`.
De database en encryptiesleutel uit de bestaande Compose-configuratie blijven in gebruik;
je bestaande account blijft dus geldig. `.env.production` blijft nodig voor die sleutel.
Login en registratie gebruiken dan HttpOnly, SameSite=Strict, Path=/ en Max-Age=604800,
zonder Secure. Hono verwacht Max-Age in seconden, niet de milliseconden van Express.
Log na de herstart opnieuw in met je bestaande account.

Gebruik voor frontend en API allebei `localhost` (frontend bijvoorbeeld
`http://localhost:5173`, API `http://localhost:3000`) en stuur bij login, registratie
en beveiligde requests `credentials: 'include'` mee. Voor een andere frontend-origin:

```sh
FRONTEND_ORIGIN=http://localhost:3001 docker compose -f compose.yaml -f compose.dev.yaml up -d
```

De override leest `FRONTEND_ORIGIN` uit de shell of de lokale `.env`, met localhost:5173
als fallback. Alleen `NODE_ENV=development` in een envbestand zetten is voor de
basis-Compose-configuratie niet voldoende: die forceert production.

### Productie met HTTPS

Docker Engine en de Compose-plugin moeten op de server aanwezig zijn. De
multi-stage image installeert met de lockfile, compileert TypeScript en draait als
onbevoorrechte `node`-gebruiker. De hostmap `./data` wordt gekoppeld aan `/app/data`.
Maak die map vooraf aan en geef de containergebruiker schrijfrechten:

```sh
mkdir -p data
sudo chown -R 1000:1000 data
```

Gebruik een eigen envbestand:

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

## Logs bekijken

De API schrijft één JSON-object per regel: `info` naar stdout, `warn` en `error`
naar stderr. Elke regel bevat `timestamp` (UTC), `level` en `event`.

```sh
# Lokaal, na yarn build:
node dist/index.js > api.log 2> api-errors.log
# Docker, inclusief recente regels en live updates:
docker compose logs --tail=100 --follow api
# Alleen de JSON-regels, zonder Compose-prefix:
docker compose logs --no-log-prefix --tail=100 api
```

HTTP-verzoeken krijgen `http_request` met methode, geregistreerd routepatroon,
uiteindelijke `statusCode` en `durationMs`, ook bij 401/403/404/413/500. Onbekende
routes heten `<unmatched>`; concrete IDs en querystrings staan niet in HTTP-logs.
Een onverwachte 500 geeft daarnaast `internal_error` met vaste reden.

```json
{"timestamp":"2026-10-15T10:00:00.000Z","level":"info","event":"http_request","method":"POST","route":"/computers/:id/off","statusCode":202,"durationMs":12.4}
{"timestamp":"2026-10-15T10:00:01.000Z","level":"error","event":"power_action","action":"off","computerId":"f02c60e1-f7fb-44e8-ae76-cf35487b878f","outcome":"failure","reason":"auth_failed"}
```

Poweracties loggen `on`/`off`, de opgeslagen computer-ID en succes of fout.
Vaste foutredenen zijn `hostkey_mismatch`, `auth_failed`, `connect_failed`,
`connect_timeout`, `command_timeout`, `command_failed`, `udp_failed`,
`udp_timeout`, `credential_decryption` en `unknown`. HTTP-responses blijven
algemeen; technische foutdetails gaan niet naar clients of logs.

`startup`, `shutdown_started` en `shutdown_complete` tonen de levenscyclus;
`shutdown_failed` meldt een vaste foutreden. `startup_failed` geeft uitsluitend
bekende configuratiecontroles of toegestane bind-/SQLite-foutcodes met een vaste
handelingsgerichte melding. Onbekende opstartfouten krijgen een algemene melding.

Bodies, headers, cookies, sessietokens, e-mailadressen, wachtwoorden, SSH-sleutels,
passphrases, encryptiesleutels, ruwe foutmeldingen/stacks en SSH-uitvoer worden
niet gelogd. Volledige SSH-controles geven `ssh_check` met alleen computer-ID en
`outcome` (`ready`, `auth_failed`, `host_key_mismatch`, `unreachable` of `error`).
Periodieke TCP-probes en WebSocket-frames produceren geen logs.
Een falende logsink verandert de HTTP-respons of poweractie niet.

## Back-up en verificatie

Stop de API vóór een eenvoudige bestandsback-up en bewaar de volledige
SQLite-datadirectory (inclusief eventuele WAL/SHM-bestanden) en **de oorspronkelijke
encryptiesleutel** afzonderlijk en beschermd. Bij Docker: stop eerst Compose en
kopieer/archiveer de hostmap `data/` met behoud van eigenaar en rechten; zet de
sleutel uit het afgeschermde envbestand veilig apart. Herstel data en sleutel
samen en controleer de schrijfrechten voordat de API opnieuw start.
Verwijder de map `data/` niet wanneer je data wilt behouden. Een nieuwe
sleutel maakt bestaande credentials onleesbaar; een verloren sleutel kan niet
uit de database worden teruggehaald.

De tests gebruiken echte SQLite/auth/Hono en WebSocket-framing via geheugenstreams,
met vervangende TCP/SSH/WOL-adapters. Voer ze uit met `yarn test` en compileer met
`yarn build`. Controleer op de doelserver daarnaast HTTPS, websockets, WOL en SSH
met echte hardware; de tests vervangen die controles niet.

## Bestanden in Git

Broncode, tests, `yarn.lock`, Docker-configuratie, `.env.example` en documentatie
horen in Git. Echte `.env`-bestanden, SQLite-data, SSH-sleutels, logs, dependencies,
buildoutput en lokale agentbestanden zijn uitgesloten via `.gitignore`.
Bewaar de database en encryptiesleutel veilig buiten Git, ook bij het verhuizen
naar een Raspberry Pi.
