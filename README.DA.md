# Dobbelt Pi-hole-kontrolpanel

[English](README.md) | **Dansk** | [Deutsch](README.DE.md)

Et let kontrolpanel til samlet administration af to, tre eller fire Pi-hole v6-installationer.
Browseren indlæser `index.html`, en ekstern JSON-konfiguration og en lokal
Chart.js-fil. Der er ingen applikationsbackend, database eller frontend-buildproces.
Installationerne angives i én central JSON-fil. Et lille Python-værktøj danner
browserens offentlige konfiguration og nginx-proxyerne fra denne fil; i Docker
sker det automatisk ved opstart.

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
- Ingen applikationsbackend
- Ingen database
- Ingen frontend-buildproces
- Python bruges kun til validering og generering af konfiguration ved installation eller containeropstart
- Serveradresser, antal, standardnavne og standardsprog i én ekstern JSON-fil
- Egne navne og visningsindstillinger gemmes lokalt i browseren
- Direkte kommunikation med Pi-hole v6 API gennem nginx

Chart.js indlæses som en separat lokal fil og bruges kun til graferne.

## Krav

- To til fire Pi-hole **v6**-installationer med REST API. Løsningen fungerer ikke med
  det gamle PHP API i Pi-hole v5.
- Docker med Compose eller nginx og Python 3.10 eller nyere til manuel installation.
- Netværksadgang fra kontrolpanelets nginx til alle konfigurerede Pi-hole-API'er.
- Et app password til hver Pi-hole. Det oprettes under **Settings → API** i den
  enkelte Pi-holes eget webinterface.

## Opsætning med Docker

Fra en lokal kopi af dette repository:

```bash
cp config/config.example.json config/config.json
```

Redigér `config/config.json` med navne og API-adresser for dine to til fire
installationer, og start derefter kontrolpanelet:

```bash
docker compose up --build -d
docker compose logs dashboard
```

Åbn **http://localhost:8080**, og log ind på hver aktiv Pi-hole med dens app
password. Compose binder som standard kun til Docker-værtens loopback-adresse.
Brug en HTTPS reverse proxy på samme vært, eller tilpas portbindingen i
`compose.yaml`, hvis kontrolpanelet skal kunne åbnes direkte på lokalnettet.
[nginx.conf.DA.example](nginx.conf.DA.example) viser en valgfri HTTPS-proxy foran
kontrolpanelet.

Mappen `./config` monteres skrivebeskyttet som `/config`. Ved opstart validerer
containeren `/config/config.json`, danner begge konfigurationer og kontrollerer
nginx, før den starter. En manglende eller ugyldig konfiguration stopper opstarten.
Chart.js medfølger i imaget; der hentes ingen eksterne filer ved opstart.

Efter ændringer i konfigurationen genstartes containeren, og browserfanen
indlæses igen:

```bash
docker compose restart dashboard
```

## Manuel opsætning med nginx

1. Kopiér `index.html` til webmappen, eksempelvis
   `/srv/web/pihole-dashboard/index.html`, og hent Chart.js til samme mappe:

   ```bash
   curl --fail --location -o /srv/web/pihole-dashboard/chart.umd.min.js \
     https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
   ```

2. Kopiér [config/config.example.json](config/config.example.json) til en privat
   placering som `/etc/dobbelt-pi-hole/config.json`, og tilpas navne og API-adresser.
   Kildens JSON-fil må ikke ligge i webmappen.
3. Dan browserkonfigurationen og nginx-proxyerne fra samme fil:

   ```bash
   python3 tools/render_config.py \
     --config /etc/dobbelt-pi-hole/config.json \
     --output-dir /etc/nginx/dobbelt-pi-hole \
     --web-root /srv/web/pihole-dashboard \
     --listen-address 127.0.0.1
   ```

4. Tilføj `include /etc/nginx/dobbelt-pi-hole/nginx.conf;` i nginx-konfigurationens
   eksisterende `http`-blok. Den genererede server lytter på `127.0.0.1:8080`.
   [nginx.conf.DA.example](nginx.conf.DA.example) kan bruges som en valgfri
   HTTPS-proxy foran serveren; tilpas domænet og certifikatstierne.
5. Kontrollér og genindlæs nginx, og åbn derefter kontrolpanelet for at logge ind:

   ```bash
   nginx -t && systemctl reload nginx
   ```

Kør værktøjet, og genindlæs nginx igen efter ændringer i JSON-filen.
[Konfigurationsvejledningen](docs/CONFIGURATION.md) (på engelsk) beskriver alle
felter, TLS, filrettigheder og opgradering fra tidligere versioner.

## Antal servere og navne

**`config.json` er den fælles kilde til installationsopsætningen.** Listen
`servers` indeholder to, tre eller fire objekter, hver med et fast `id`
(`"1"` til `"4"`), `label` og `apiUrl`. Antallet af objekter bestemmer
serverantallet, og rækkefølgen bestemmer visningsrækkefølgen. `verifyTls` er som
standard `true` for HTTPS-forbindelser til Pi-hole. Se
[eksemplet](config/config.example.json) og [JSON-skemaet](config/config.schema.json).

Serverfarverne følger deres ID: blå, gul, lilla og orange. Visningen tilpasser
sig antallet og skærmbredden med en maksimal sidebredde på 1900 px.
API-stierne genereres automatisk; Pi-hole-adresser skal ikke vedligeholdes
separat i nginx eller HTML.

Navne kan også ændres under **Indstillinger**. De gemmes i browserens
`localStorage` og erstatter de konfigurerede navne i netop den browser.
**Gendan standardnavne** gendanner de aktuelle standardnavne fra filen.
Antal installationer og deres adresser administreres i JSON-filen. En
webgrænseflade til redigering af den centrale konfiguration er planlagt til
senere.

Ved opgradering fra v1.3.007 eller tidligere flyttes installationsoplysningerne
fra HTML og nginx til JSON-filen. De gamle API-proxyblokke erstattes med den
genererede konfiguration. Eksisterende lokale navne overføres, men du skal
**logge ind én gang på ny** på hver installation, fordi sessioner nu er knyttet
til den konfigurerede API-adresse. Ændres en API-adresse senere, viser en gammel
fane en besked om ændret konfiguration og kræver genindlæsning, før nye kald
sendes. Ændringer af navne eller rækkefølge ændrer ikke API-identiteten.

## Sprog

Brugerfladen findes på **English**, **Dansk** og **Deutsch**.
Sprogvælgeren øverst i kontrolpanelet ændrer straks brugerfladen, herunder
dialogtekster, dynamiske meddelelser, tabeller og grafer. Tal, procenttal,
datoer og klokkeslæt følger det valgte sprog.

Det indledende sprog vælges i denne rækkefølge:

1. Et understøttet sprog, der tidligere er valgt og gemt i browserens
   `localStorage`.
2. Det konfigurerede `defaultLanguage`, hvis det er `da`, `en` eller `de`.
   Standardværdien `auto` går videre til browserens sprogindstillinger.
3. Det første understøttede sprog i browserens prioriterede sprogliste.
   Regionale varianter som `de-DE`, `de-AT`, `en-GB` og `da-DK` understøttes.
4. Engelsk, hvis der ikke findes et understøttet sprog.

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
  restriktiv en Content Security Policy kan være. Den genererede nginx-konfiguration
  indeholder en politik, der understøtter de indlejrede scripts og den lokale Chart.js-fil.
- Hvis kontrolpanelet afvikles på en Synology NAS, kan en profil til
  adgangskontrol i DSM begrænse adgangen til bestemte IP-adresser eller lokale
  netværk.

Kontrolpanelet bør ikke eksponeres direkte på internettet uden passende
adgangskontrol foran det.

## Roadmap

- **v1.1.005:** Komplet dansk og engelsk brugerflade og dokumentation
- **v1.2.006:** Understøttelse af to, tre eller fire Pi-hole-installationer
- **v1.3.007:** Nøglebaseret flersproget understøttelse med komplet dansk, engelsk og tysk brugerflade og dokumentation
- **v1.4.008:** Ekstern JSON-konfiguration, genererede API-proxyer og Docker-image
- **Planlagt:** Webgrænseflade til redigering af den centrale installationsopsætning

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

Docker-imaget indeholder Chart.js 4.4.1 og dets MIT-licens i
`/usr/share/licenses/chart.js/LICENSE`. Ved manuel installation hentes Chart.js
separat som beskrevet ovenfor. Chart.js er et selvstændigt tredjepartsprojekt.
