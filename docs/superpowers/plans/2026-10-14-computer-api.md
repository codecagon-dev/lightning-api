# Lightning API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Een beveiligde TypeScript API voor persoonlijke computers, Wake-on-LAN, SSH-shutdown en live bereikbaarheidsstatus.

**Architecture:** Hono HTTP-routes gebruiken repositories voor SQLite en services voor authenticatie, encryptie en netwerkacties. Eén begrensde poller onderhoudt een statuscache; een geauthenticeerde WebSocket-server distribueert uitsluitend eigen computerstatussen.

**Tech Stack:** Node.js >=24.0.0, TypeScript ESM, Hono, @hono/node-server, ws, ssh2, expliciete strikte validatie, dotenv, node:sqlite, node:crypto, node:test en tsx.

**Spec:** `docs/superpowers/specs/2026-10-14-computer-api-design.md`

## Global Constraints

- Volg boilmeter-api met routes, services en repositories; geen frontend of beheerfuncties buiten de spec.
- Linux is de standaard; Windows gebruikt eveneens SSH voor afsluiten.
- Exacte frontend-Origin; productie HTTPS/WSS met HttpOnly, Secure, SameSite=Strict sessiecookie.
- AES-256-GCM met verplichte externe 32-byte sleutel, verse nonce en computer/eigenaarbinding; geen geheimen in responses of logs.
- Sessies hebben minstens 256 bits willekeur en verlopen na zeven dagen; database bevat alleen de tokenhash.
- Computeracties controleren computer-ID én eigenaar; andermans computers geven 404.
- Pollinterval tien seconden, maximaal tien gelijktijdige probes, geen overlappende rondes.
- De omgeving heeft Node v26.10.0 maar geen npm in PATH. Zoek eerst een beschikbare package manager; installeer alleen lokaal in workspace of /tmp indien nodig. Rapporteer eventuele netwerkblokkade eerlijk.
- `.git` is een lege, alleen-lezen mount en geen repository. Voer geen commits uit zolang geen beschrijfbare geldige repository beschikbaar is; bewaar wijzigingen in deze workspace.

## Review Focus

- Verkeerd gespelde en extra JSON-velden worden geweigerd, niet stil genegeerd (taak 3).
- Beschadigde ciphertext of gewijzigde eigenaar/ID mag nooit bruikbare credentials opleveren (taak 1).
- Een onbekende host key voorkomt iedere shutdown-opdracht (taak 4).
- Logout en sessieverloop beëindigen ook bestaande WebSocket-verbindingen (taak 5).
- Een trage of weggevallen WebSocket-client mag polling en andere gebruikers niet blokkeren (taak 5).

## Bestandsindeling

- `src/config.ts`, `src/database.ts`, `src/types.ts`: configuratie, schema en gedeelde contracten.
- `src/repositories/{user,session,computer}.repository.ts`: parameterized SQL en eigenaarschap.
- `src/services/{credentials,auth,wol,ssh,status}.service.ts`: afzonderlijke verantwoordelijkheden.
- `src/routes/{auth,computers}.ts`, `src/middleware/security.ts`: HTTP, validatie en sessiebeveiliging.
- `src/ws/computers.ts`: upgrade-authenticatie en distributie.
- `src/app.ts`, `src/index.ts`: appfactory, wiring en lifecycle.
- `tests/{credentials,auth,computers,power,status,websocket}.test.ts`: echte assertions zonder live computers.
- `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `README.md`: project en gebruik.

### Task 1: Configuratie, database en credentialversleuteling

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/config.ts`, `src/database.ts`, `src/types.ts`, `src/services/credentials.service.ts`, `tests/credentials.test.ts`.

**Interfaces:** `loadConfig(env: NodeJS.ProcessEnv): Config`; `openDatabase(path: string): DatabaseSync`; `encryptCredentials(key: Buffer, computerId: string, ownerId: string, credentials: Credentials): string`; `decryptCredentials(key: Buffer, computerId: string, ownerId: string, ciphertext: string): Credentials`. `Credentials` is een union van wachtwoord of private key met optionele passphrase. `Computer` bevat de specvelden, `id`, `ownerId`, `createdAt` en `encryptedCredentials`; `PublicComputer` bevat geen eigenaar of ciphertext. `Status` is `unknown | online | offline` met `checkedAt: string | null`.

- [x] Zoek beschikbare package manager; maak ESM-project met `dev`, `build`, `start` en `test` scripts. Installeer dependencies en types lokaal; pin opgeloste versies via lockfile.
- [x] Schrijf tests: roundtrip behoudt credentials; gelijke plaintext levert verschillende ciphertext; plaintext is afwezig; tampering en andere computer/eigenaar werpen fout; ontbrekende of verkeerd lange sleutel stopt config-loading.
- [x] Run `npm test -- tests/credentials.test.ts` (of equivalent voor gevonden package manager); bevestig falen door ontbrekende implementatie.
- [x] Implementeer functies, schema met users/sessions/computers, WAL/foreign keys en strikte productieconfiguratie. Stel HTTP-bodylimiet op 64 KiB en credentiallimiet op 32 KiB; SSH-connect/commandtimeout tien seconden, TCP-probetimeout twee seconden, localhostbinding standaard.
- [x] Run credentialtests en `npm run build`; verwacht alle tests groen en compiler zonder fouten.

### Task 2: Accounts, sessies en browserbeveiliging

**Files:** `src/repositories/user.repository.ts`, `src/repositories/session.repository.ts`, `src/services/auth.service.ts`, `src/middleware/security.ts`, `src/routes/auth.ts`, `src/app.ts`, `tests/auth.test.ts`.

**Interfaces:** `AuthService.register(email: string, password: string): Promise<{ user: User; token: string }>`; `login(...)` met hetzelfde resultaat; `authenticate(token: string): UserSession | null`; `logout(token: string): void`; `UserSession` bevat `userId`, `sessionId`, `expiresAt`. `createApp(deps: AppDependencies): Hono` maakt HTTP-testen via `app.request` mogelijk. Sessie-intrekking is observeerbaar via `onRevoke(listener: (sessionId: string) => void)`.

- [x] Schrijf tests voor registratie/login, unieke genormaliseerde email, onjuist wachtwoord, verlopen sessie, logout, cookieflags, geweigerde Origin en toegestane niet-browserrequest zonder Origin. Assert dat database geen plaintext-wachtwoord of sessietoken bevat.
- [x] Run auth-tests en bevestig het verwachte falen.
- [x] Implementeer scrypt met unieke salt, timing-safe vergelijking en willekeurige 32-byte sessies. Valideer email en password van 12–128 tekens. Gebruik generieke loginfouten, cookie `lightning_session`, zeven dagen levensduur, intrekking en opruiming. Beperk register/login tot tien pogingen per minuut per direct socket-IP met begrensde opslag en opruiming; forceer geen X-Forwarded-For-vertrouwen. Voorkom onbegrensde gelijktijdige scrypt-verzoeken.
- [x] Implementeer exacte Origin/CORS-controle voor muterende requests, begrensde bodies en uniforme gesanitiseerde JSON-fouten. Geef publieke gebruiker uitsluitend ID en email terug.
- [x] Run auth-tests en build; verwacht succes.

### Task 3: Persoonlijke computerregistratie en overzicht

**Files:** `src/repositories/computer.repository.ts`, `src/routes/computers.ts`, `tests/computers.test.ts`.

**Interfaces:** `ComputerRepository.create(ownerId: string, input: ComputerInput): Computer`; `findOwned(ownerId: string, id: string): Computer | null`; `listOwned(ownerId: string): Computer[]`; `listAll(): Computer[]`. `toPublicComputer(computer: Computer, status: ComputerStatus): PublicComputer` gebruikt expliciete veldselectie. De repository krijgt de encryptieservice geïnjecteerd; input bevat plaintext alleen tijdens registratie.

- [x] Schrijf tests voor geldige registratie, Linux/defaultpoorten, Windows, beide credentialvarianten, normalisatie MAC, ongeldige IPv4/MAC/poort/fingerprint, dubbele of ontbrekende credentials, onbekende velden en eigenaarinjectie. Assert scheiding tussen twee gebruikers en afwezigheid van geheimen in alle responses en SQLite-plaintext.
- [x] Run computertests en bevestig falen.
- [x] Implementeer strikte Zod-schema's met specgrenzen, servergegenereerde UUID/eigenaar/tijd en parameterized queries. Implementeer POST/GET /computers met initiële status `unknown`; valideer fingerprint als OpenSSH SHA256-fingerprint. Nieuwe registratie triggert eigenaarssnapshot via geïnjecteerde callback.
- [x] Run computertests plus eerdere tests en build; verwacht succes.

### Task 4: WOL, gecontroleerde SSH en power-endpoints

**Files:** `src/services/wol.service.ts`, `src/services/ssh.service.ts`, `src/routes/computers.ts`, `tests/power.test.ts`.

**Interfaces:** `buildMagicPacket(macAddress: string): Buffer`; `sendWakePacket(computer: Computer): Promise<void>`; `shutdownComputer(computer: Computer, credentials: Credentials): Promise<void>`. `PowerActions` heeft `wake(computer: Computer)` en `shutdown(computer: Computer)` en is injecteerbaar in de app. Gebruik geïnjecteerde socket/SSH-clientfactory voor unit tests.

- [x] Schrijf tests die exact 102 pakketbytes controleren, juiste broadcast/poort en socketcleanup bij succes/fout. Test de twee vaste shutdowncommando's, host-keymismatch zonder exec, loginweigering, connecttimeout, commandtimeout, nonzero exit en onverwachte disconnect vóór acceptatie.
- [x] Schrijf HTTP-tests: andermans/ontbrekende computer geeft 404 zonder netwerkaanroep; eigen computer geeft 202 na verzending/acceptatie; netwerkfout geeft gesanitiseerde 502/504. Een mislukte decryptie voert geen SSH-actie uit.
- [x] Run powertests en bevestig falen.
- [x] Implementeer de exacte routes POST /computers/:id/on en POST /computers/:id/off (geen /wake of /shutdown aliases). Implementeer UDP-broadcast met cleanup en ssh2 met SHA256-host-keyvergelijking. Linux gebruikt exact `sudo -n /sbin/shutdown -h now`; Windows `shutdown.exe /s /t 0`. Ruim verbindingen en timers op; stuur geen willekeurige clientcommando's. Accepteer SSH-resultaat uitsluitend bij exitcode 0.
- [x] Run powertests en eerdere tests, build; verwacht succes.

### Task 5: Polling en gebruikersgebonden WebSockets

**Files:** `src/services/status.service.ts`, `src/ws/computers.ts`, `tests/status.test.ts`, `tests/websocket.test.ts`.

**Interfaces:** `StatusService.get(computerId: string): ComputerStatus`; `pollOnce(): Promise<void>`; `start(): void`; `stop(): Promise<void>`; `onChange(listener: (computer: Computer, status: ComputerStatus) => void)`. Constructor accepteert repository en `probe(computer: Computer): Promise<Status>`. `attachComputerWebSockets(server: Server, deps: WebSocketDependencies): { close(): Promise<void>; sendSnapshot(ownerId: string): void }` gebruikt AuthService en StatusService.

- [x] Schrijf tests voor initial unknown, bereikbaarheid, weigering/timeout, interne fout, timestamp, uitsluitend gewijzigde statusupdates, maximaal tien probes en niet-overlappende rondes. Gebruik gecontroleerde promises/timers in plaats van echte computers of sleeps van tien seconden.
- [x] Schrijf tests met een echte lokale HTTP/ws-server: geen upgrade zonder sessie of met verkeerde Origin; snapshot/update bevat alleen eigen computers; registratie levert snapshot; logout/verloop sluit verbinding; pingtimeout ruimt client op; buffer boven 1 MiB sluit trage client zonder anderen te hinderen.
- [x] Run beide testbestanden en bevestig falen.
- [x] Implementeer TCP-probes met twee seconden timeout, volledige socketcleanup, statuscache en tiensecondeninterval. Gebruik tien workers en stop/start-lifecycle zonder overlap. Implementeer exacte /ws/computers-upgrade, sessiecontrole vóór upgrade, eigenaarfilter, snapshots/statusberichten en cleanup.
- [x] Run status/WebSockettests, eerdere tests en build; verwacht succes.

### Task 6: Serverlifecycle, documentatie en complete verificatie

**Files:** `src/index.ts`, `src/app.ts`, `README.md`, `.env.example`, bestaande tests indien integrationwiring extra bewijs nodig heeft.

**Interfaces:** Entrypoint maakt config/database/services/app/server eenmaal aan. SIGINT/SIGTERM stopt polling, sluit WebSockets/HTTP en daarna database. Start poller direct, log uitsluitend bindadres en poort.

- [x] Schrijf indien nodig een integratietest voor echte wiring: account registreren, computer registreren, lijst ophalen, eigenaargebonden snapshot ontvangen, logout en afgewezen volgende actie. Vervang alleen netwerk-power/probe-adapters; gebruik echte auth en database.
- [x] Run nieuwe test vóór wiring; bevestig falen.
- [x] Implementeer lifecycle en documenteer installatie, Nodeversie, envvariabelen, sleutelgeneratie, HTTPS/WSS-proxy, localhostbinding, exacte Origin, credentialed browserfetch en niet-browsercookiejar. Toon register/login/create/list/on/off requests en WebSocket-events zonder echte secrets.
- [x] Documenteer Linux sudoers uitsluitend voor de vaste shutdown-opdracht, SSH-fingerprintverkrijging via vertrouwde route, Windows OpenSSH/shutdownrechten, BIOS/netwerk-WOL en back-up van sleutel plus database. Vermeld dat status SSH-bereikbaarheid betekent en echte power-acties hardwarevalidatie vereisen.
- [x] Run tests/build en controleer lockfile, `.gitignore`, secretuitsluiting en README/interfaces: `yarn test` 53/53 pass; `yarn build` exit 0; runtime HTTP/WebSocket-smoketest in-process met echte auth/SQLite en geheugenstreams, cleanup gecontroleerd. Docker/env-artifacts statisch gecontroleerd.
- [ ] Gebonden HTTP/WSS-smoketest en Docker-build/run/Compose-CLI op echte server: lokale listen eerder EPERM, Docker-daemon toegang geweigerd, Compose-plugin ontbreekt. Niet opnieuw geprobeerd; README bevat uitvoerbare serverchecks en resterende hardwarevalidatie.
- [x] Werk plancheckboxes bij met feitelijke resultaten. Rapporteer wat werkt, welke commando's zijn uitgevoerd en eventuele onuitgevoerde hardware- of omgevingschecks zonder succesvolle uitvoering te suggereren.

## Zelfreview

Het plan dekt alle specsecties. Types, statuswaarden en methoden hierboven vormen het contract tussen taken. Alle vijf Review Focus-punten hebben expliciete tests in hun owning taak. Netwerkpower-acties worden automatisch met adapters getest; echte computers worden niet zonder beschikbare hardware als geverifieerd gerapporteerd. Planreview en uitvoering met agents zijn goedgekeurd. Alle zes implementatietaken zijn uitgevoerd en afzonderlijk gereviewd; de laatste integrale review is akkoord zonder openstaande bevindingen. Echte server-, Docker- en hardwarechecks blijven expliciet open wegens de beschreven omgevingsbeperkingen.
