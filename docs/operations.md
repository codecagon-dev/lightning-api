# Beheer

[Terug naar de README](../README.md)

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

## Back-ups en herstel

Stop de API vóór een eenvoudige bestandsback-up en bewaar de volledige
SQLite-datadirectory (inclusief eventuele WAL/SHM-bestanden) en **de oorspronkelijke
encryptiesleutel** afzonderlijk en beschermd. Bij Docker: stop eerst Compose en
kopieer/archiveer de hostmap `data/` met behoud van eigenaar en rechten; zet de
sleutel uit het afgeschermde envbestand veilig apart. Herstel data en sleutel
samen en controleer de schrijfrechten voordat de API opnieuw start.
Verwijder de map `data/` niet wanneer je data wilt behouden. Een nieuwe
sleutel maakt bestaande credentials onleesbaar; een verloren sleutel kan niet
uit de database worden teruggehaald.

## Bestanden in Git

Broncode, tests, `yarn.lock`, Docker-configuratie, `.env.example` en documentatie
horen in Git. Echte `.env`-bestanden, SQLite-data, SSH-sleutels, logs, dependencies,
buildoutput en lokale agentbestanden zijn uitgesloten via `.gitignore`.
Bewaar de database en encryptiesleutel veilig buiten Git, ook bij het verhuizen
naar een Raspberry Pi.
