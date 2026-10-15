# Docker en deployment

[Terug naar de README](../README.md)

De bestaande Dockerfile bouwt TypeScript in de container. Op de host zijn Docker
Engine en de Compose-plugin nodig; Node.js en Yarn hoeven daar niet apart te staan.
De API-host moet de computers op het LAN kunnen bereiken.

## Lokaal testen met HTTP

Voor Docker op je eigen pc is er een expliciete development-override:

Maak bij een eerste installatie `.env.production` vanuit `.env.example` en vul
`CREDENTIAL_ENCRYPTION_KEY` met de uitvoer van `openssl rand -base64 32`.
Bewaar een bestaande sleutel als je al data hebt. Maak ook `data/` aan en geef
UID/GID 1000 schrijfrechten, zoals bij de productie-instructies hieronder.

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
docker compose -f compose.yaml -f compose.dev.yaml logs -f --tail=50 api
```

Deze gebruikt `NODE_ENV=development` en standaard `FRONTEND_ORIGIN=http://localhost:5173`.
De database en encryptiesleutel uit de bestaande Compose-configuratie blijven in gebruik;
je bestaande account blijft dus geldig. `.env.production` blijft nodig voor die sleutel.
Login en registratie gebruiken dan HttpOnly, SameSite=Strict, Path=/ en Max-Age=604800,
zonder Secure. Log na het wisselen tussen HTTP-development en HTTPS-productie opnieuw in.

Gebruik voor frontend en API allebei `localhost` (frontend bijvoorbeeld
`http://localhost:5173`, API `http://localhost:3000`) en stuur bij login, registratie
en beveiligde requests `credentials: 'include'` mee. Voor een andere frontend-origin:

```sh
FRONTEND_ORIGIN=http://localhost:3001 docker compose -f compose.yaml -f compose.dev.yaml up -d
```

De override leest `FRONTEND_ORIGIN` uit de shell of de lokale `.env`, met localhost:5173
als fallback. Alleen `NODE_ENV=development` in een envbestand zetten is voor de
basis-Compose-configuratie niet voldoende: die forceert production.

## Productie met HTTPS

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
# Genereer alleen voor een nieuwe installatie een sleutel:
# openssl rand -base64 32
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
De Compose-omgeving forceert productie, localhost, poort 3000 en het databasepad in de gekoppelde datamap.
`restart: unless-stopped` herstart de service; `init: true` helpt signalen en
procesopruiming. Secrets worden pas via `.env.production` geïnjecteerd en niet in
de image gebakken. Publiceer `docker compose config`-output met secrets niet;
gebruik `--quiet`. `.dockerignore` sluit secrets, lokale data en configuratie uit.

## Reverse proxy en cookies

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

## Raspberry Pi

Gebruik bij voorkeur Raspberry Pi OS 64-bit (`uname -m` geeft `aarch64`) en bouw
op de Pi zelf met de bovenstaande productiecommando's. Er is geen aparte
Dockerfile of cross-compilatie nodig. Gebruik dezelfde LAN-verbinding als de
computers die je met WOL wilt wekken.

De API luistert met de productieconfiguratie op `127.0.0.1:3000`. Voor toegang
vanaf andere apparaten is de HTTPS-proxy op de Pi dus ook nodig.

## Een bestaande installatie verhuizen

Stop de API op de oude host voordat je de volledige map `data/` kopieert.
Neem daarnaast de oorspronkelijke `CREDENTIAL_ENCRYPTION_KEY` over in het
beveiligde `.env.production` op de nieuwe host; genereer hiervoor geen nieuwe key.
Pas `FRONTEND_ORIGIN` aan de nieuwe frontend aan en zorg dat UID/GID 1000 op de
nieuwe host de datamap kan schrijven. Accounts en computers staan in SQLite en
verhuizen daarmee mee.

Zie [beheer en back-ups](operations.md) voor herstel en logcontrole.
