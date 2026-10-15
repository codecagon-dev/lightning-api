# API-referentie

Deze referentie beschrijft de huidige HTTP-endpoints en WebSocket van Lightning API. Er is geen `/api`-prefix. Gebruik in productie HTTPS en WSS. Lokaal is het standaardadres `http://localhost:3000`.

## Algemene afspraken

- Requests met account- of computergegevens vereisen `Content-Type: application/json`.
- JSON-objecten voor registratie/login, computerregistratie en computerwijzigingen zijn strikt: onbekende velden geven 400.
- De maximale HTTP-body is 64 KiB. De gecombineerde JSON met SSH-credentials mag maximaal 32 KiB zijn, inclusief UTF-8-encoding en JSON-escaping.
- Authenticatie gebruikt de `lightning_session`-cookie. Registreren en inloggen zetten deze cookie; er staat geen token in de responsebody.
- De cookie is HttpOnly, SameSite=Strict, zeven dagen geldig en in productie Secure. Frontend en API moeten voor browsergebruik same-site zijn. Gebruik `credentials: 'include'` bij cross-origin fetch.
- Een aanwezige `Origin` moet exact overeenkomen met `FRONTEND_ORIGIN`. Niet-browserclients mogen de Origin weglaten. CORS-preflights gebruiken `OPTIONS` en geven 204 bij een toegestane Origin.
- Computergegevens en acties zijn uitsluitend beschikbaar voor de eigenaar. Een onbekende computer en een computer van iemand anders geven beide 404.
- HTTP-fouten hebben de vorm `{"error":"melding"}`. SSH-credentials, wachtwoordhashes en sessietokens worden nooit teruggegeven.

## Endpointoverzicht

| Methode | Pad | Authenticatie | Succes |
| --- | --- | --- | --- |
| POST | `/auth/register` | Nee | 201, gebruiker en sessiecookie |
| POST | `/auth/login` | Nee | 200, gebruiker en sessiecookie |
| POST | `/auth/logout` | Niet verplicht | 204, lege body; sessie ingetrokken |
| GET | `/auth/me` | Ja | 200, huidige gebruiker |
| POST | `/computers` | Ja | 201, aangemaakte computer |
| GET | `/computers` | Ja | 200, eigen computers met status |
| PATCH | `/computers/:id` | Ja | 200, bijgewerkte computer |
| DELETE | `/computers/:id` | Ja | 204, registratie en credentials verwijderd; lege body |
| POST | `/computers/:id/on` | Ja | 202, WOL-pakket verzonden |
| POST | `/computers/:id/check-ssh` | Ja | 200, TCP- en SSH-diagnose |
| POST | `/computers/:id/off` | Ja | 202, SSH-shutdown succesvol uitgevoerd |
| GET (WebSocket-upgrade) | `/ws/computers` | Ja | 101, statusverbinding |

Er zijn momenteel geen wachtwoordreset- of admin-endpoints.

## Accounts

### POST /auth/register

| Veld | Type | Verplicht | Regels |
| --- | --- | --- | --- |
| `email` | string | Ja | Geldig emailadres, maximaal 254 tekens na trimmen; wordt naar kleine letters omgezet |
| `password` | string | Ja | 12–128 tekens; wordt niet getrimd |

```json
{"email":"operator@example.com","password":"voorbeeld-wachtwoord-123"}
```

Succes: **201** en een `Set-Cookie`-header. Registreren logt de gebruiker direct in.

```json
{"user":{"id":"550e8400-e29b-41d4-a716-446655440000","email":"operator@example.com"}}
```

Fouten: 400 bij ongeldige velden/JSON, 409 `Email already registered`, 415 bij een verkeerd contenttype, 429 bij te veel pogingen of gelijktijdige wachtwoordberekeningen. Algemene fouten onderaan zijn ook mogelijk.

### POST /auth/login

Dezelfde requestvelden en validatie als registratie. Succes: **200**, dezelfde gebruikersresponse en een nieuwe sessiecookie. Een fout wachtwoord of onbekend account geeft **401** met `{"error":"Invalid email or password"}`. Foutcodes 400, 415 en 429 zijn eveneens mogelijk.

Registreren en inloggen delen een limiet van tien pogingen per minuut per direct client-IP. Achter een reverse proxy kunnen gebruikers daarom dezelfde limiet delen. Forwarded-IP-headers worden niet vertrouwd.

### POST /auth/logout

Geen requestbody nodig. Trekt de huidige sessie in, verwijdert de cookie en sluit de WebSockets van die sessie. Succes: **204 zonder body**, ook als er geen geldige sessie was.

### GET /auth/me

Geen requestbody. Succes: **200** met dezelfde `{"user":{"id":"...","email":"..."}}`-vorm. Zonder geldige sessie: **401** met `{"error":"Authentication required"}`.

## Computers

### POST /computers

| Veld | Type | Verplicht | Standaard / regels |
| --- | --- | --- | --- |
| `name` | string | Ja | Niet leeg of alleen spaties; maximaal 100 tekens |
| `color` | string of null | Nee | `null`; exact `#RRGGBB`, hoofdletterongevoelig, opgeslagen als kleine letters |
| `os` | string | Nee | `linux` (standaard) of `windows` |
| `ipAddress` | string | Ja | Geldig IPv4-adres; geen hostname of IPv6 |
| `macAddress` | string | Ja | Zes hexadecimale octetten, met consequent `:` of `-`; opgeslagen als kleine letters met `:` |
| `broadcastAddress` | string | Ja | Geldig IPv4-broadcastadres voor het LAN |
| `sshPort` | integer | Nee | 22; bereik 1–65535 |
| `wolPort` | integer | Nee | 9; bereik 1–65535 |
| `sshUsername` | string | Ja | Niet leeg of alleen spaties; maximaal 128 tekens |
| `sshHostKeyFingerprint` | string | Ja | Canonieke OpenSSH SHA256-fingerprint: `SHA256:` en 43 base64tekens, zonder afsluitende `=` |
| `sshPassword` | string | Keuze | Niet leeg; exact één van wachtwoord of private key |
| `sshPrivateKey` | string | Keuze | Private-keyinhoud met eventuele newlines; exact één van key of wachtwoord |
| `sshPrivateKeyPassphrase` | string | Nee | Uitsluitend samen met `sshPrivateKey`; een lege string is toegestaan |

Controleer de hostfingerprint via een vertrouwde console op de computer. Geef geen eigenaar, ID, status, datum of shutdown-opdracht mee: die velden worden niet geaccepteerd.

Voorbeeld met fictieve gegevens; vervang de fingerprint door de echte, vertrouwd gecontroleerde fingerprint:

```json
{
  "name": "Werkkamer",
  "color": "#3366cc",
  "os": "linux",
  "ipAddress": "192.168.1.20",
  "macAddress": "aa:bb:cc:dd:ee:ff",
  "broadcastAddress": "192.168.1.255",
  "sshPort": 22,
  "wolPort": 9,
  "sshUsername": "lightning",
  "sshHostKeyFingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "sshPassword": "fictief-ssh-wachtwoord"
}
```

Succes: **201** met `{"computer": Computer}`. `Computer` heeft de publieke velden hieronder. De initiële status is `unknown` met `checkedAt: null`. Fouten: 400 `Invalid computer input`, 401 zonder sessie of 415 zonder JSON-contenttype, naast algemene fouten.

### Publieke computerresponse

```json
{
  "computer": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "Werkkamer",
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

`color` staat altijd in de response: een hexkleur met kleine letters of `null`. Weglaten en expliciet `null` betekenen geen kleur; er wordt geen standaardkleur gekozen. Bestaande computers krijgen bij de automatische databasemigratie `null`.

`id` is een servergegenereerde UUID. `createdAt` en een niet-lege `checkedAt` zijn ISO-datums. Status is `unknown`, `online` of `offline`. SSH-wachtwoord, private key, passphrase, ciphertext en eigenaar-ID ontbreken altijd.

### GET /computers

Geen requestbody of queryparameters nodig. Succes: **200** met `{"computers":[Computer]}`. Een lege lijst is `{"computers":[]}`. Alle computers zijn van de ingelogde gebruiker. Iedere computer heeft de bovenstaande publieke velden en de laatste status/controletijd. Zonder sessie: **401**.

### PATCH /computers/:id

Wijzigt een eigen computer met een niet-leeg JSON-object. Alle velden van `POST /computers` zijn afzonderlijk wijzigbaar, met dezelfde validatie en normalisatie. Weggelaten velden behouden hun huidige waarde; er worden geen registratiestandaarden opnieuw toegepast. `color: null` verwijdert de kleur. Andere verplichte computergegevens mogen niet `null` zijn. Onbekende velden en servervelden zoals `id`, `ownerId`, `createdAt`, status en ciphertext worden geweigerd.

```json
{"name":"Nieuwe naam","color":null,"sshPort":2222}
```

Zonder credentialvelden blijft de versleutelde credentialinhoud exact behouden, ook wanneer deze niet te ontsleutelen is. `sshPassword` vervangt alle eerdere key/passphrasegegevens. `sshPrivateKey` vervangt alle eerdere credentials; geef de eventuele passphrase opnieuw mee, anders wordt deze verwijderd. Wachtwoord en key samen, of wachtwoord en passphrase samen, zijn ongeldig.

Alleen `sshPrivateKeyPassphrase` wijzigen kan bij een bestaande, leesbare private key. Een string vervangt de passphrase; `null` verwijdert deze. Bij een nieuwe key is een eventuele passphrase een string (of weggelaten). De gecombineerde nieuwe credential-JSON blijft beperkt tot 32 KiB.

Succes: **200** met `{"computer": Computer}`, zonder secrets. ID, eigenaar en aanmaakdatum blijven behouden. Elke succesvolle wijziging zet TCP- en SSH-status terug op `unknown`, maakt de controletijden `null` en verwijdert de automatische SSH-loginblokkade. Alle WebSockets van de eigenaar krijgen een vernieuwd snapshot. De volgende poll gebruikt de bijgewerkte gegevens. Resultaten van eerdere controles worden genegeerd; die controles blijven tot afronding meetellen voor de capaciteitslimiet. Een handmatige controle tijdens zo'n oude controle geeft 503 en kan daarna opnieuw worden aangevraagd.

Fouten: **400** bij een lege patch, ongeldige velden/JSON, credentialcombinatie of passphrasewijziging zonder leesbare key; **401** zonder sessie; **404** voor onbekende/andermans computers of verwijdering tijdens het lezen van de body; **415** zonder JSON-contenttype. Algemene fouten zijn ook mogelijk.

### DELETE /computers/:id

Geen requestbody nodig. Verwijdert uitsluitend de registratie en opgeslagen SSH-credentials van een eigen computer. De fysieke pc blijft ongemoeid: dit voert geen WOL- of shutdownactie uit. Er is geen herstelendpoint.

Succes: **204 zonder body**. Zonder geldige sessie: **401** `Authentication required`. Een onbekende, al verwijderde of andermans computer geeft steeds **404** `Not found`. Algemene fouten zoals 403 bij een verkeerde Origin zijn ook mogelijk.

Alle WebSockets van de eigenaar krijgen een vernieuwd snapshot zonder de verwijderde computer. Lopende statuscontroles leveren daarna geen statusbericht voor die computer meer op.

### SSH-status en automatische controles

Publieke computers, snapshots en statusberichten bevatten altijd `sshStatus` en
`sshCheckedAt`. De laatste is een ISO-tijd van de laatste volledige SSH-controle of
`null`; TCP-probes veranderen deze tijd niet. De velden zijn tijdelijk, zonder
nieuwe databasekolommen.

| `sshStatus` | Betekenis |
| --- | --- |
| `unknown` | Nog geen actuele SSH-controle; ook na terugkeer online tijdens de wachttijd |
| `ready` | De opgeslagen SHA256-hostkey is vertrouwd en de opgeslagen credentials loggen succesvol in |
| `auth_failed` | SSH-authenticatie geweigerd |
| `host_key_mismatch` | De aangeboden hostkey wijkt af van de opgeslagen fingerprint |
| `unreachable` | TCP offline of SSH-verbinding mislukt/verbroken/verlopen |
| `error` | Interne controlefout of opgeslagen credentials niet te ontsleutelen |

Alleen wanneer de TCP-status `online` is controleert de API automatisch SSH,
hoogstens eenmaal per zestig seconden. De bestaande TCP-controle blijft iedere tien
seconden lopen. Na `auth_failed`, `host_key_mismatch` of onleesbare credentials zijn
automatische pogingen geblokkeerd tot een handmatige volledige SSH-controle of computerwijziging. Die
blokkade overleeft offline/online-overgangen, maar geen procesherstart: na herstart
kan opnieuw een poging volgen. Offline TCP maakt oude SSH-readiness ongeldig, met
behoud van de laatste `sshCheckedAt`. Terugkeer online tijdens de wachttijd geeft
`unknown` tot de volgende volledige controle.

Elke SSH-controle opent een korte verbinding, valideert de hostkey, authenticeert met
het opgeslagen wachtwoord of de private key en eventuele passphrase, en sluit
direct. Er blijft geen sessie ingelogd. De controle opent geen shell en voert geen
exec, sudo, SFTP of shutdown uit. `ready` bewijst geen shutdownrechten.

### POST /computers/:id/check-ssh

Vereist een geldige sessie en een eigen computer. Stuur een **lege requestbody**
(geen `{}`). Voert een verse TCP-probe uit en alleen bij `online` een volledige
SSH-controle. Een handmatige poging mag de automatische wachttijd en blokkade
overslaan. Is TCP offline of onbekend, dan worden geen credentials aangeboden; een
bestaande loginblokkade blijft dan staan.

Succes: **200**, ook wanneer de afgeronde diagnose mislukt:

```json
{"computerId":"550e8400-e29b-41d4-a716-446655440001","status":"online","checkedAt":"2026-10-15T12:00:10.000Z","sshStatus":"auth_failed","sshCheckedAt":"2026-10-15T12:00:10.000Z"}
```

Fouten: 400 bij een niet-lege body, 401 zonder sessie, 404 voor onbekende/andermans
computers of verwijdering tijdens de controle, 429 bij volle capaciteit, 503 wanneer
de checker niet beschikbaar is, een oude controle na een wijziging nog loopt, of afsluiten nieuwe controles verhindert. Er komen
geen ruwe fouten of credentials in de response.

Gelijktijdige handmatige/automatische controles voor dezelfde computer delen één
poging. De globale limiet is tien gelijktijdige computercontroles; overtollig werk
wordt afgewezen of overgeslagen zonder onbeperkte wachtrij. Afsluiten wacht op
lopende controles en start geen nieuwe. Een gewijzigde TCP- **of** SSH-status
verschijnt direct in een WebSocket-statusbericht voor de eigenaar; ongewijzigde
statussen worden niet opnieuw gepusht. GET geeft wel verse controletijden.

### POST /computers/:id/on

Vervang `:id` door de opgeslagen computer-ID. Geen requestbody nodig: adres, MAC en poort komen uit de database. Stuurt een UDP Wake-on-LAN-pakket naar het opgeslagen broadcastadres en de WOL-poort.

Succes: **202** met `{"ok":true}`. Dit bevestigt verzending, niet dat de pc daadwerkelijk is gestart. Fouten: 401, 404, 502 of 504, naast algemene fouten.

### POST /computers/:id/off

Vervang `:id` door de opgeslagen computer-ID. Geen requestbody nodig. Controleert de SSH-host key, logt in met de opgeslagen credentials en voert de vaste opdracht voor het OS uit:

- Linux: `sudo -n /sbin/shutdown -h now`.
- Windows: `shutdown.exe /s /t 0`.

Succes: **202** met `{"ok":true}` nadat de SSH-opdracht succesvol is afgerond. Een verbindingsverlies zonder bevestigde exitcode 0 geldt als fout, ook als de computer ondertussen afsluit. Fouten: 401, 404, 502 of 504, naast algemene fouten. Dit endpoint schakelt de computer daadwerkelijk uit.

## WebSocket /ws/computers

Gebruik `wss://<api-host>/ws/computers` met de sessiecookie. Browsers sturen die zelf mee. De URL moet exact dit pad bevatten; extra queryparameters of een afsluitende slash worden geweigerd. Een token in de URL authenticeert niet. Er zijn geen clientberichten nodig om updates te ontvangen.

Na de succesvolle **101**-upgrade volgt een snapshot met dezelfde publieke computerobjecten als `GET /computers`:

```json
{"type":"snapshot","computers":[]}
```

Na computerregistratie, wijziging en verwijdering wordt opnieuw een snapshot naar alle verbindingen van de eigenaar gestuurd. Snapshots bevatten ook `color` (hexkleur of `null`). Een verwijderde computer verdwijnt uit het snapshot; lopende probes sturen geen latere status voor die ID. Bij een statuswijziging volgt:

```json
{"type":"status","computerId":"550e8400-e29b-41d4-a716-446655440001","status":"online","checkedAt":"2026-10-15T12:00:10.000Z","sshStatus":"ready","sshCheckedAt":"2026-10-15T12:00:10.000Z"}
```

De server controleert elke tien seconden de SSH-TCP-poort. `online` betekent bereikbaar, `offline` onbereikbaar, `unknown` nog niet gecontroleerd of een onverwachte interne controlefout. Dit bewijst geen fysieke aan/uit-status of succesvolle SSH-login. Ongewijzigde statussen worden niet opnieuw gepusht; `GET /computers` geeft wel de laatste controletijd.

Logout en sessieverloop beëindigen de verbinding. De server gebruikt ping/pong en beëindigt stille verbindingen en clients met meer dan 1 MiB uitgaande buffer. Inkomende berichten zijn maximaal 64 KiB.

Fouten vóór de upgrade gebruiken een lege HTTP-body: 400 bij ongeldige handshake, 401 zonder geldige sessie, 403 bij een verkeerde Origin, 404 bij een verkeerd pad en 500 bij een interne authenticatiefout. De `ws`-library kan protocolongeldige handshakes ook zelf afwijzen, onder andere met 400 of 405. Na upgrade zijn verbindingsproblemen WebSocket-events, geen JSON HTTP-responses; de applicatie kan de verbinding abrupt beëindigen.

## Algemene HTTP-fouten

| Status | Mogelijke melding / betekenis |
| --- | --- |
| 400 | `Empty body required`, `Invalid JSON body`, `Invalid request fields`, `Invalid email or password format` of `Invalid computer input` |
| 401 | `Authentication required` of bij login `Invalid email or password` |
| 403 | `Origin not allowed` |
| 404 | `Not found`; onbekende route of onbekende/andermans computer |
| 409 | `Email already registered` |
| 413 | `Request body too large` |
| 415 | `JSON body required` |
| 429 | `Too many requests` |
| 500 | `Internal server error`; details worden niet openbaar gemaakt |
| 502 | `Power action failed`; bijvoorbeeld SSH-login, host-keycontrole, opdracht of WOL-verzending mislukt |
| 503 | `SSH check unavailable`; checker niet beschikbaar of API sluit af |
| 504 | `Power action timed out` |

Een foutresponse ziet er bijvoorbeeld zo uit:

```json
{"error":"Authentication required"}
```

Zie [de README](../README.md) voor installatie, Docker, HTTPS-proxy, sudoers en WOL-instellingen.
