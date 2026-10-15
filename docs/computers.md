# Computers voorbereiden

[Terug naar de README](../README.md)

## SSH en afsluitrechten

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

## Wake-on-LAN

Schakel wake via LAN/PCIe in BIOS/UEFI en in de netwerkadapterdriver in.
Controleer standbyvoeding, bekabelde LAN-ondersteuning, MAC-adres en subnet-
broadcastadres. Switches, firewalls, slaapstanden en Windows Fast Startup kunnen
WOL verhinderen. Docker-host en computers horen op het computer-LAN; de router
moet broadcast doorlaten als ze niet op hetzelfde subnet staan. Een TCP-status-
test bewijst geen werkende WOL of shutdown: beide vereisen echte hardwarevalidatie.

Het broadcastadres is niet het subnetmasker. Bijvoorbeeld: bij IP-adres
`192.168.1.20` en subnetmasker `255.255.255.0` is het broadcastadres
`192.168.1.255`. Gebruik het broadcastadres van jouw eigen subnet en het MAC-adres
van de netwerkadapter die WOL ondersteunt. De UDP-poort is standaard 9.

Een succesvolle WOL-response bevestigt dat de API het pakket heeft verstuurd;
het is geen ontvangstbevestiging van de pc. Vergelijk bij problemen MAC-adres,
broadcastadres en poort met een werkende WOL-app, en controleer of beide verzenders
hetzelfde LAN kunnen bereiken.
