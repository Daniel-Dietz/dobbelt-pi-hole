# Dobbelt Pi-hole-kontrolpanel

[English](README.md) | **Dansk** | [Deutsch](README.DE.md)

Et let kontrolpanel til samlet administration af to, tre eller fire Pi-hole v6-installationer.
Løsningen består af én selvstændig `index.html` uden backend, database eller
buildproces. Browseren kommunikerer direkte med de aktive Pi-hole-installationers
REST API gennem en nginx reverse proxy.

Kontrolpanelet indeholder:

- Dashboard med samlede tal og grafer
- Fælles forespørgselslog med filtrering og sortering
- Administration af tilladte og blokerede domæner
- Lokale DNS-poster med visning af forskelle mellem installationerne
- Kendte klienter og forslag til ukendte enheder
- Administration af adlists
- Gravity-opdatering på hver installation med tidspunktet for seneste opdatering
- Handlinger, der kan udføres på én eller alle aktive installationer
- Dansk, engelsk og tysk brugerflade

Pi-hole-installationerne forbliver selvstændige DNS-servere. Projektet
opretter ikke failover, virtuel IP, primær eller sekundær server eller automatisk
baggrundssynkronisering. Formålet er at gøre det enkelt at administrere de
relevante indstillinger ens fra ét kontrolpanel.

![Pi-hole dashboard](images/dashboard.png)

## Letvægt som udgangspunkt

Kontrolpanelet er bevidst holdt enkelt:

- Én HTML-fil med HTML, CSS og JavaScript
- Ingen backend
- Ingen database
- Ingen buildproces
- Ingen Node.js, PHP eller Python
- Antal servere samt deres navne på tværs af klienter sættes i HTML-filen; egne navne og visningsindstillinger gemmes lokalt i browseren
- Direkte kommunikation med Pi-hole v6 API gennem nginx

Chart.js indlæses som en separat lokal fil og bruges kun til graferne.

## Krav

- To til fire Pi-hole **v6**-installationer med REST API. Løsningen fungerer ikke med
  det gamle PHP API i Pi-hole v5.
- nginx eller en tilsvarende reverse proxy foran kontrolpanelet. Forespørgsler
  til `/api1/...` og `/api2/...` samt `/api3/...` og `/api4/...`, når de bruges,
  skal videresendes til de tilsvarende Pi-hole-installationer. Dermed undgås CORS-problemer.
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
   webfilerne. Sæt `DEFAULT_SERVER_COUNT` i `index.html` til `2`, `3` eller `4`.
   nginx-eksemplet har `/api1/` og `/api2/` aktive som standard. Fjern
   kommentartegnene fra `/api3/`-blokken, og tilpas den ved tre installationer.
   Ved fire installationer aktiveres og tilpasses både `/api3/` og `/api4/`.
5. Kontrollér og genindlæs nginx:

   ```bash
   nginx -t && systemctl reload nginx
   ```

6. Åbn kontrolpanelets adresse og log ind på alle aktive Pi-hole-installationer med
   deres app passwords.

## Antal servere og navne

Antallet af aktive Pi-hole sættes **kun i `index.html`**:

```js
const DEFAULT_SERVER_COUNT = 2; // 2, 3 eller 4
```

De første to, tre eller fire poster i `DEFAULT_SERVERS` bruges. API-stierne er
`/api1`, `/api2`, `/api3` og `/api4`. nginx skal have en proxy til hver aktiv
installation. De faktiske værtsnavne eller IP-adresser angives i nginx og ikke
i browserens indstillinger.

Standardnavne på tværs af klienter angives med `label` i `DEFAULT_SERVERS`:

```js
const DEFAULT_SERVERS = [
    { id: "1", label: "Pi-hole 1", base: "/api1", color: "c-1", chip: "s1" },
    { id: "2", label: "Pi-hole 2", base: "/api2", color: "c-2", chip: "s2" },
    { id: "3", label: "Pi-hole 3", base: "/api3", color: "c-3", chip: "s3" },
    { id: "4", label: "Pi-hole 4", base: "/api4", color: "c-4", chip: "s4" },
];
```

Serverfarverne er henholdsvis blå, gul, lilla og orange. Visningen tilpasser sig
antallet og skærmbredden med en maksimal sidebredde på 1900 px.

Navnene på de aktive installationer kan også ændres under **Indstillinger**.
Disse navne gemmes i browserens `localStorage` og erstatter standardnavnene i
netop den browser. Antallet og API-stierne kan ikke ændres under Indstillinger.
Ændringer af standardnavne i filen overskriver ikke lokalt gemte navne.

## Sprog

Brugerfladen findes på **English**, **Dansk** og **Deutsch**.
Sprogvælgeren øverst i kontrolpanelet ændrer straks brugerfladen, herunder
dialogtekster, dynamiske meddelelser, tabeller og grafer. Tal, procenttal,
datoer og klokkeslæt følger det valgte sprog.

Det indledende sprog vælges i denne rækkefølge:

1. Et understøttet sprog, der tidligere er valgt og gemt i browserens
   `localStorage`.
2. Det første understøttede sprog i browserens prioriterede sprogliste.
   Regionale varianter som `de-DE`, `de-AT`, `en-GB` og `da-DK` understøttes.
3. Engelsk, hvis der ikke findes et understøttet sprog.

Oversættelserne bruger faste meddelelsesnøgler og navngivne parametre i
komplette `en`-, `da`- og `de`-kataloger indlejret i `index.html`. Et nyt
sprog kræver hverken backend, buildproces eller yderligere afhængigheder
ved afvikling. Servernavne, domæner, klientnavne, kommentarer og andre værdier
fra brugere eller Pi-hole-API'erne ændres ikke, når brugerfladens sprog skiftes.

Opsætningsvejledning og nginx-eksempler findes også på alle tre sprog:

| Sprog | Dokumentation | nginx-eksempel |
| --- | --- | --- |
| English | [README.md](README.md) | [nginx.conf.example](nginx.conf.example) |
| Dansk | [README.DA.md](README.DA.md) | [nginx.conf.DA.example](nginx.conf.DA.example) |
| Deutsch | [README.DE.md](README.DE.md) | [nginx.conf.DE.example](nginx.conf.DE.example) |

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
- **v1.2.006:** Understøttelse af to, tre eller fire Pi-hole-installationer
- **v1.3.007:** Nøglebaseret flersproget understøttelse med komplet dansk, engelsk og tysk brugerflade og dokumentation
- **v1.4.xxx:** Docker-image og forenklet installation

Kontrolpanelet understøtter to til fire aktive installationer. Ekstra
installationer kræver både det tilsvarende antal i `index.html` og en proxy i nginx.

## Bidrag

Issues og pull requests er velkomne. Bidrag kan blandt andet være fejlrettelser,
forslag og oversættelser til flere sprog. Brug de samme meddelelsesnøgler og
navngivne parametre i alle sprogkataloger, og medtag oversættelser af statisk
tekst, dynamiske tilstande og tilgængelighedstekster.
Se [oversættelsesvejledningen](docs/I18N.md) (på engelsk) for hjælpefunktioner,
tilføjelse af sprog og kørsel af de automatiske kontroller.

## Licens

Copyright © 2023–2026 Christian Kragh Jessen  
https://christiankragh.dk

Projektet blev oprindeligt udviklet til Pi-hole v5 i 2023 og opdateret til
Pi-hole v6 i 2026.

Projektet er udgivet under MIT-licensen og må bruges, kopieres, ændres og
videredistribueres i overensstemmelse med licensens vilkår. Se filen `LICENSE`.

Chart.js medfølger ikke og skal hentes separat som beskrevet under opsætningen.
Chart.js er et selvstændigt tredjepartsprojekt med sin egen licens.
