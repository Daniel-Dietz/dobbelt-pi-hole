# Dobbelt Pi-hole-kontrolpanel

[English](README.md) | **Dansk**

Et let kontrolpanel til samlet administration af to Pi-hole v6-installationer.
Løsningen består af én selvstændig `index.html` uden backend, database eller
buildproces. Browseren kommunikerer direkte med begge Pi-hole-installationers
REST API gennem en nginx reverse proxy.

Kontrolpanelet indeholder:

- Dashboard med samlede tal og grafer
- Fælles forespørgselslog med filtrering og sortering
- Administration af tilladte og blokerede domæner
- Lokale DNS-poster med visning af forskelle mellem installationerne
- Kendte klienter og forslag til ukendte enheder
- Administration af adlists
- Gravity-opdatering på hver installation
- Handlinger, der kan udføres på én eller begge installationer
- Dansk og engelsk brugerflade

De to Pi-hole-installationer forbliver selvstændige DNS-servere. Projektet
opretter ikke failover, virtuel IP, primær eller sekundær server eller automatisk
baggrundssynkronisering. Formålet er at gøre det enkelt at administrere de
relevante indstillinger ens fra ét kontrolpanel.

## Letvægt som udgangspunkt

Kontrolpanelet er bevidst holdt enkelt:

- Én HTML-fil med HTML, CSS og JavaScript
- Ingen backend
- Ingen database
- Ingen buildproces
- Ingen Node.js, PHP eller Python
- Indstillinger gemmes lokalt i browseren
- Direkte kommunikation med Pi-hole v6 API gennem nginx

Chart.js indlæses som en separat lokal fil og bruges kun til graferne.

## Krav

- To Pi-hole **v6**-installationer med REST API. Løsningen fungerer ikke med
  det gamle PHP API i Pi-hole v5.
- nginx eller en tilsvarende reverse proxy foran kontrolpanelet. Forespørgsler
  til `/api1/...` og `/api2/...` skal videresendes til de to faktiske
  Pi-hole-installationer. Dermed undgås CORS-problemer.
- Et app password til hver Pi-hole. Det oprettes under **Settings → API** i den
  enkelte Pi-holes eget webinterface.

## Opsætning

1. Kopiér `index.html` til den mappe, hvor nginx skal levere kontrolpanelet fra,
   eksempelvis `/srv/web/pihole-dashboard/index.html`.
2. Download Chart.js til samme mappe:

   ```bash
   cd /srv/web/pihole-dashboard
   curl -o chart.umd.min.js https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
   ```

3. Kopiér `nginx.conf.DA.example` til din nginx-konfiguration.
4. Tilpas domænet, Pi-hole-adresserne, certifikatstierne og placeringen af
   webfilerne.
5. Kontrollér og genindlæs nginx:

   ```bash
   nginx -t && systemctl reload nginx
   ```

6. Åbn kontrolpanelets adresse og log ind på begge Pi-hole-installationer med
   deres app passwords.

Kontrolpanelet forventer de faste relative API-stier `/api1` og `/api2`.
nginx-skabelonen videresender disse til de faktiske Pi-hole-installationer.
Det er derfor ikke nødvendigt at redigere `index.html` for at angive deres
adresser.

De viste servernavne kan ændres under **Indstillinger**. Navnene gemmes i
browserens `localStorage`, mens API-stierne fortsat er `/api1` og `/api2`.

## Sprog

Brugerfladen findes på dansk og engelsk. Første gang vælges sproget automatisk
ud fra browserens sprog. Det kan efterfølgende ændres øverst i kontrolpanelet,
og valget gemmes lokalt i browseren.

## Sikkerhed

- Løsningen er beregnet til personlig brug eller personer, du har tillid til.
  Alle, der kan logge ind, får administratoradgang til de tilknyttede
  Pi-hole-installationer.
- Login-sessioner gemmes i browserens `sessionStorage` og forsvinder, når fanen
  lukkes. Adgangskoder gemmes ikke.
- Kontrolpanelet neutraliserer værdier, der ikke er tillid til, før de vises,
  eksempelvis klientnavne, domæner og kommentarer.
- Løsningen indeholder JavaScript direkte i HTML-filen. Det begrænser, hvor
  restriktiv en Content Security Policy kan være. Se kommentaren i
  `nginx.conf.DA.example`.
- Hvis kontrolpanelet afvikles på en Synology NAS, kan en profil til
  adgangskontrol i DSM begrænse adgangen til bestemte IP-adresser eller lokale
  netværk.

Kontrolpanelet bør ikke eksponeres direkte på internettet uden passende
adgangskontrol foran det.

## Roadmap

- **v1.1.005:** Komplet dansk og engelsk brugerflade og dokumentation
- **v1.2.xxx:** Understøttelse af op til fire Pi-hole-installationer
- **v1.3.xxx:** Flere sprog
- **v1.4.xxx:** Docker-image og forenklet installation

Koden til flere installationer skal være dynamisk, mens op til fire
installationer bliver det officielt understøttede og testede layout.

## Bidrag

Issues og pull requests er velkomne. Bidrag kan blandt andet være fejlrettelser,
forslag og senere oversættelser til flere sprog.

## Licens

Copyright © 2023–2026 Christian Kragh Jessen  
https://christiankragh.dk

Projektet blev oprindeligt udviklet til Pi-hole v5 i 2023 og opdateret til
Pi-hole v6 i 2026.

Projektet er udgivet under MIT-licensen og må bruges, kopieres, ændres og
videredistribueres i overensstemmelse med licensens vilkår. Se filen `LICENSE`.

Chart.js medfølger ikke og skal hentes separat som beskrevet under opsætningen.
Chart.js er et selvstændigt tredjepartsprojekt med sin egen licens.
