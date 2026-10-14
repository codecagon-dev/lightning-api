# Lightning API ontwerp

## Doel en context

Een TypeScript API waarmee ingelogde gebruikers hun eigen computers kunnen registreren, via Wake-on-LAN kunnen starten en via SSH kunnen afsluiten. De API draait op hetzelfde lokale netwerk als de computers. De browser ontvangt live bereikbaarheidsupdates via een geauthenticeerde WebSocket.

Volg de structuur van `../boilmeter-api/boilmeter-api`: Node.js, TypeScript ESM, Hono, `ws`, `node:sqlite`, met routes, services en repositories. Gebruik een ondersteunde Node.js-versie met `node:sqlite`. Linux is de standaard; Windows is eveneens een toegestane OS-keuze en gebruikt SSH voor afsluiten.

## HTTP-interface

Alle bodies en responses gebruiken JSON. Credentials worden nooit teruggestuurd.

| Methode | Pad | Gedrag |
| --- | --- | --- |
| POST | /auth/register | Account aanmaken en sessie starten |
| POST | /auth/login | Account authenticeren en nieuwe sessie starten |
| POST | /auth/logout | Sessie intrekken en cookie verwijderen |
| GET | /auth/me | Ingelogde gebruiker ophalen |
| POST | /computers | Computer registreren voor de huidige gebruiker |
| GET | /computers | Alleen eigen computers met hun laatste status ophalen |
| POST | /computers/:id/on | WOL-pakket versturen voor een eigen computer |
| POST | /computers/:id/off | Vaste shutdown-opdracht uitvoeren via SSH |
| GET (upgrade) | /ws/computers | Eigen bereikbaarheidsstatus ontvangen |

Registratie en login accepteren `email` en `password`. Registratie retourneert 201; login 200. Authenticatiefouten zijn generiek. Logout retourneert 204. Computerregistratie retourneert 201 met de computer zonder geheimen. Power-acties retourneren 202 na succesvolle verzending respectievelijk geaccepteerde SSH-opdracht. Een aan-antwoord bevestigt uitsluitend verzending van het WOL-pakket.

Ongeldige input geeft 400, ontbrekende of verlopen authenticatie 401, een ongeldige Origin 403, een onbekende of andermans computer 404, rate limiting 429 en mislukte netwerkacties 502 of 504. Publieke fouten bevatten geen credentials of SSH-debuguitvoer.

## Computergegevens

- `name`: niet-lege weergavenaam, maximaal 100 tekens.
- `os`: `linux` of `windows`, standaard `linux`.
- `ipAddress`: geldig IPv4-adres; hostnames en IPv6 vallen buiten de eerste versie.
- `macAddress`: zes hexadecimale octetten, normaliseren naar dubbelepuntnotatie.
- `broadcastAddress`: geldig IPv4-adres voor het betreffende LAN.
- `sshPort`: integer 1–65535, standaard 22.
- `wolPort`: integer 1–65535, standaard 9.
- `sshUsername`: niet-lege SSH-gebruikersnaam, maximaal 128 tekens.
- `sshHostKeyFingerprint`: SHA-256 fingerprint van de verwachte SSH-host key, verplicht en niet automatisch vertrouwen bij eerste contact.
- Exact één van `sshPassword` of `sshPrivateKey`; bij een private key is `sshPrivateKeyPassphrase` optioneel.

De server genereert UUID, eigenaar en aanmaaktijd. De client kan geen eigenaar, status of shutdown-opdracht instellen. Begrens requests en credentiallengtes; weiger onbekende velden zodat verkeerd gespelde credentialvelden geen stilzwijgende fouten veroorzaken. Publieke computergegevens bevatten alleen niet-geheime configuratie en status.

## Database en geheimen

SQLite met foreign keys en WAL. Tabellen: `users`, `sessions` en `computers`, met indexen voor sessieverloop en computereigenaar. Alle computerqueries voor HTTP-acties zijn gebonden aan zowel computer-ID als gebruiker-ID.

Wachtwoorden worden met Node.js scrypt en een unieke willekeurige salt gehasht. Vergelijk hashes in constante tijd. Sessie-tokens hebben minstens 256 bits willekeur; alleen hun SHA-256-hash staat in de database. Sessies verlopen na zeven dagen en kunnen worden ingetrokken.

SSH-geheimen vormen één JSON-payload die met AES-256-GCM wordt versleuteld. Gebruik een verse nonce per versleuteling en bind computer-ID en gebruiker-ID als authenticated associated data. De 32-byte encryptiesleutel komt uit een verplichte environmentvariabele en wordt niet in de database opgeslagen. Ontbrekende of ongeldige configuratie stopt het opstarten. Credentials komen niet in responses of logs. Documenteer dat databaseback-ups en encryptiesleutel beide nodig zijn om credentials te herstellen.

## Transport en sessiebeveiliging

Productie gebruikt HTTPS/WSS via een reverse proxy. De Node-server bindt standaard aan localhost; LAN-binding is expliciet configureerbaar. Een expliciete lokale developmentmodus mag HTTP gebruiken.

Gebruik een HttpOnly sessiecookie met SameSite=Strict, Path=/ en in productie Secure. Productie vereist een geconfigureerde exacte frontend-Origin. Controleer die Origin voor muterende browserrequests en WebSocket-upgrades. Gebruik geen wildcard-CORS met credentials. Verzoeken zonder Origin blijven mogelijk voor niet-browserclients met een geldige sessie; browsers gebruiken de toegestane Origin. Login en registratie krijgen begrensde rate limiting op het directe client-IP; vertrouw forwardingheaders niet automatisch.

WebSocket-authenticatie gebruikt de sessiecookie, nooit tokens in queryparameters. Controleer de sessie vóór de upgrade. Sluit verbindingen bij logout en sessieverloop. Elke snapshot en update wordt gefilterd op de eigenaar; clients kunnen geen alternatieve gebruiker opgeven.

## Wake-on-LAN en SSH

WOL stuurt via UDP een magic packet van zes 0xff-bytes gevolgd door zestien herhalingen van het MAC-adres, met broadcast ingeschakeld naar het geconfigureerde broadcastadres en de WOL-poort. Sluit de socket na verzending of fout. WOL moet op de computer in firmware en netwerkkaart zijn ingeschakeld; Wi-Fi en sommige slaapstanden kunnen WOL beperken.

SSH gebruikt een daarvoor geschikte Node-library, expliciete host-keycontrole en begrensde verbinding- en opdrachttijden. Er worden uitsluitend vaste opdrachten uitgevoerd:

- Linux: `sudo -n /sbin/shutdown -h now`.
- Windows: `shutdown.exe /s /t 0`.

De Linux-gebruiker moet via sudoers uitsluitend de benodigde shutdown-opdracht zonder wachtwoord mogen uitvoeren; Windows vereist OpenSSH Server en shutdownrechten. Documenteer fingerprintverkrijging en installatievoorwaarden. Een verbinding die verdwijnt zonder bevestigde opdrachtacceptatie wordt als fout gerapporteerd; statuscontrole kan daarna wel onbereikbaarheid laten zien.

## Bereikbaarheidscontrole en WebSocket

Controleer elke tien seconden via een TCP-verbinding met de SSH-poort, met een korte timeout en maximaal tien gelijktijdige probes. Overlappende pollrondes worden voorkomen. Dit toont SSH-bereikbaarheid, geen bewezen fysieke powerstatus.

Status is `unknown` vóór de eerste controle, daarna `online` bij een geslaagde TCP-verbinding of `offline` bij weigering/timeout. Een onverwachte interne probe-fout geeft `unknown`. Bewaar `checkedAt` in de statuscache. Na een herstart begint de cache opnieuw met `unknown`.

Na verbinding ontvangt de eigenaar `{ type: 'snapshot', computers: [...] }`. Wijzigingen komen als `{ type: 'status', computerId, status, checkedAt }`. Alleen gewijzigde statussen worden gepusht; GET /computers geeft de meest recente controletijd. Nieuwe eigen computers verschijnen via een nieuwe snapshot. Gebruik ping/pong om verbroken verbindingen op te ruimen en sluit trage clients met te veel gebufferde data.

## Structuur en verificatie

Houd HTTP-routes, account- en sessielogica, computerrepository, credentialversleuteling, WOL, SSH, polling en WebSockets gescheiden. Injecteer netwerkadapters waar nodig om tests zonder echte computers te draaien.

Verifieer accountregistratie/login/logout, eigenaarschap bij elke computeractie, het ontbreken van geheimen in responses en plaintext-opslag, encryptie-integriteit, inputvalidatie, host-keyweigering, exacte WOL-pakketbytes, shutdown-opdrachtselectie, timeouts, statusovergangen en WebSocket-isolatie inclusief verlopen/ingetrokken sessies. Draai TypeScript-build en geautomatiseerde tests. Echte WOL en shutdown blijven afhankelijk van de gebruikershardware en worden gedocumenteerd als aparte handmatige verificatie.

Lever een README met installatie, environmentconfiguratie, HTTPS-proxyvoorwaarden, account- en computerrequests, WebSocket-events en Linux/Windows-instellingen. Geen frontend, computerbewerking/verwijdering, wachtwoordreset of adminbeheer in deze versie.

## Deploymentkeuze na ontwerpgoedkeuring

De gebruiker heeft uitvoering met agents gekozen en de deploymentkeuze gedelegeerd. Lever Docker Compose voor een Linux-host in hetzelfde LAN: host networking voor WOL, SQLite in een persistent volume, onprivileged runtime en een host HTTPS reverse proxy voor de standaard localhostbinding. Credentials en encryptiesleutel komen uit een operator-created envbestand en worden niet in het image opgenomen. Direct Node starten blijft mogelijk. Er wordt in deze sessie geen externe server gedeployd; Docker-build en echte WOL worden uitsluitend als geverifieerd gemeld als die daadwerkelijk konden worden uitgevoerd.
