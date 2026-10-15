# Lightning API

Beheer je eigen computers op het lokale netwerk: aanzetten met Wake-on-LAN,
afsluiten via SSH en hun bereikbaarheid volgen via een WebSocket.

De API is gebouwd met TypeScript, Hono en SQLite. Er is geen frontend inbegrepen.

## Mogelijkheden

- Accounts met sessiecookies en computers per gebruiker.
- Computers toevoegen, wijzigen en verwijderen, met een optionele kleur.
- Wake-on-LAN via het ingestelde MAC-adres, broadcastadres en de UDP-poort.
- Linux- en Windows-computers afsluiten via SSH.
- SSH-inloggegevens versleuteld opslaan en de hostkey controleren.
- TCP-bereikbaarheid en SSH-authenticatie volgen via HTTP en WebSocket.

Een bereikbare SSH-poort betekent niet automatisch dat inloggen lukt. De API
rapporteert daarom apart `status` en `sshStatus`. Een verzonden WOL-pakket
bevestigt evenmin dat de pc daadwerkelijk is gestart.

## Snel starten

Vereist Node.js 24 of hoger en Yarn Classic 1.22.

```sh
yarn install --frozen-lockfile
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Vul de gegenereerde sleutel in bij `CREDENTIAL_ENCRYPTION_KEY` in `.env`, en start:

```sh
chmod 600 .env
yarn dev
```

De API is lokaal bereikbaar op `http://localhost:3000`. De voorbeeldconfiguratie
staat een frontend op `http://localhost:5173` toe. Bewaar de encryptiesleutel:
zonder de oorspronkelijke sleutel zijn opgeslagen SSH-gegevens niet te herstellen.

Voor Docker, een Linux-server of Raspberry Pi: zie de
[deploymenthandleiding](docs/deployment.md). Productie gebruikt HTTPS en een
reverse proxy. Bereid de doelcomputers voor voordat je WOL of SSH gebruikt.

## Documentatie

| Onderwerp | Handleiding |
| --- | --- |
| Endpoints, requestvelden, responses en WebSocket | [API-referentie](docs/api.md) |
| Lokale ontwikkeling, configuratie en browsergebruik | [Ontwikkeling](docs/development.md) |
| Docker, HTTPS, Raspberry Pi en verhuizen | [Deployment](docs/deployment.md) |
| WOL, SSH-hostkeys en afsluitrechten | [Computers voorbereiden](docs/computers.md) |
| Logs, back-ups en bestanden in Git | [Beheer](docs/operations.md) |

## Ontwikkeling

```sh
yarn test
yarn build
```

De tests vervangen externe TCP-, SSH- en WOL-acties door testadapters. Test
netwerkbereikbaarheid en hardwareacties ook op je eigen installatie.

## Gebouwd met AI

Deze API is **gevibecode**: de code en documentatie zijn met behulp van
AI-codingagents tot stand gekomen. Dat geldt ook voor een groot deel van de tests.

## Licentie

Beschikbaar onder de [MIT-licentie](LICENSE).
