# Dobbelt Pi-hole-kontrolpanel

[English](README.md) | **Dansk** | [Deutsch](README.DE.md)

Et let kontrolpanel til samlet administration af to, tre eller fire Pi-hole v6-installationer.
Browseren indlæser `index.html`, en ekstern JSON-konfiguration og en lokal
Chart.js-fil. Der er ingen applikationsbackend, database eller frontend-buildproces.
Installationerne angives i én central JSON-fil. Et lille Python-værktøj danner
browserens offentlige konfiguration og nginx-proxyerne fra denne fil. I Docker
og den native Proxmox LXC-tjeneste sker det automatisk ved opstart.

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

## Aktuel status og dokumentation

**Gennemgået 2026-10-18:** den aktuelle applikationsversion er **1.5.009**.
Ekstern konfiguration, Docker-installation, den native LXC-installer og
beskyttelse mod API- og loginomdirigeringer er implementeret på `main`.
[Udviklingsoversigten i #6](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/6)
beskriver det resterende arbejde og dets acceptkriterier;
[roadmap nedenfor](#roadmap) gengiver den samme rækkefølge.

Installation kræver i øjeblikket en lokal kopi af kildekoden og, ved Docker,
et lokalt bygget image. Versionerede udgivelsesfiler og offentliggjorte images
er planlagt i [#17](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/17).
Afprøvning og godkendelse af installation og gendannelse på en rigtig
Proxmox-vært er fortsat åben i
[#24](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/24).

| Vejledning | Indhold |
| --- | --- |
| Denne README | Funktioner, [Docker](#opsætning-med-docker), [Proxmox LXC](#automatisk-opsætning-i-proxmox-lxc), [manuel nginx](#manuel-opsætning-med-nginx), aktuelle begrænsninger og roadmap |
| [Konfiguration](docs/CONFIGURATION.md) | JSON-felter, API-rettigheder, genererede ruter, TLS, konfigurationsændringer og migrering |
| [LXC-installation og drift](docs/LXC.md) | Værtskrav, CLI-parametre, tjenestekommandoer, fejlsøgning, backup og gendannelse |
| [Oversættelser og frontend-kontroller](docs/I18N.md) | Sprogkataloger, tilføjelse af sprog, enheds- og browsertests |
| [Udvikling](docs/DEVELOPMENT.md) | Kildekodens opbygning, læsbar kode, engelsk funktionsdokumentation og testgrupper |

De detaljerede vejledninger under `docs/` er på engelsk; alle tre README-filer
beskriver installation, aktuel status og roadmap med issues på deres eget sprog.

## Arkitektur og installation

Kontrolpanelet er bevidst holdt enkelt:

- Én HTML-fil med HTML, CSS og JavaScript
- Ingen applikationsbackend
- Ingen database
- Ingen frontend-buildproces
- Python håndterer installationen og danner konfiguration ved installation eller tjenestestart
- Serveradresser, antal, standardnavne og standardsprog i én ekstern JSON-fil
- Egne navne og visningsindstillinger gemmes lokalt i browseren
- Direkte kommunikation med Pi-hole v6 API gennem nginx

Chart.js indlæses som en separat lokal fil og bruges kun til graferne.

**nginx er webserver og proxy til Pi-hole-API'et i alle tre installationsformer.**
Du åbner kontrolpanelet i din egen browser; der kører ingen browser i Docker
eller LXC. Python håndterer installation og generering af konfiguration.
Node.js og Playwright er udviklingsværktøjer, der bruges til tests.

| Installation | Applikationstjeneste | Kontrolpanelets standardadresse |
| --- | --- | --- |
| Docker Compose | nginx i containeren med et image bygget fra denne lokale kildekode | Docker-værtens `127.0.0.1:8080` |
| Native Proxmox LXC | nginx under `dobbelt-pi-hole.service` i en Debian 13-CT | CT'ens IPv4-adresse, port `8080` |
| Manuel nginx | Din nginx-tjeneste med den genererede konfiguration | `127.0.0.1:8080` med eksempelkommandoen nedenfor |

Kontrolpanelet administrerer eksisterende Pi-hole-installationer. Installationen
installerer ikke Pi-hole og ændrer ikke de DNS-servere, dine netværksklienter får
oplyst.

## Krav

- To til fire Pi-hole **v6**-installationer med REST API. Løsningen fungerer ikke med
  det gamle PHP API i Pi-hole v5.
- Docker med Compose, **Proxmox VE 9 på amd64** til automatisk LXC-installation
  eller nginx og Python 3.10 eller nyere til manuel installation.
- Netværksadgang fra kontrolpanelets nginx til alle konfigurerede Pi-hole-API'er.
- Et app password til hver Pi-hole. Det oprettes under **Settings → API** i den
  enkelte Pi-holes eget webinterface.

Et vellykket login med app password giver ikke tilladelse til alle ændringer.
Ændringer af lokale DNS-poster afhænger af Pi-holes indstilling
`webserver.api.app_sudo`; læs om
[API-rettigheder](docs/CONFIGURATION.md#pi-hole-api-permissions), før du ændrer
rettighederne.

## Opsætning med Docker

Hent en lokal kopi af kildekoden, og forbered konfigurationen:

```bash
git clone https://github.com/Daniel-Dietz/dobbelt-pi-hole.git
cd dobbelt-pi-hole
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

## Automatisk opsætning i Proxmox LXC

Installationsværktøjet opretter en ny **uprivilegeret Debian 13-LXC** og
installerer nginx, Python, kontrolpanelet og verificerede Chart.js-filer direkte
i den. Kør værktøjet som **root på Proxmox VE 9-værten** fra en komplet lokal
kopi af projektet:

```bash
cd /root/dobbelt-pi-hole
cp config/config.example.json config/config.json
# Edit config/config.json with your own Pi-hole instances.
python3 tools/create_lxc.py \
  --config /root/dobbelt-pi-hole/config/config.json \
  --storage local-lvm \
  --template-storage local \
  --bridge vmbr0 \
  --hostname dobbelt-pi-hole
```

Brug lagre og en netværksbro, der findes på din node. Som standard vælger
værktøjet et ledigt CT-ID i hele klyngen, den nyeste Debian 13 standard-skabelon
for amd64 fra Proxmox-kataloget og DHCP. Tilføj `--dry-run` for at kontrollere
lokale filer og se de planlagte kommandoer uden downloads eller ændringer.
En fast adresse kan for eksempel angives med
`--ipv4 192.168.1.50/24 --gateway 192.168.1.1`.

Tjenesten lytter på **CT'ens adresse, port 8080**. Brug en HTTPS reverse proxy
foran tjenesten, og begræns adgangen med eksisterende firewall- eller proxyregler.
Installationsværktøjet aktiverer firewallflaget på CT'ens netkort, men opretter
ikke regler og ændrer ikke værtens netværk. Kører den foranstillede nginx-proxy
på en anden maskine, erstattes `127.0.0.1:8080` i eksemplet med CT'ens adresse.

Konfigurationen kopieres til `/etc/dobbelt-pi-hole/config.json` inde i CT'en.
Anvend ændringer i denne kopi fra Proxmox-værten; erstat `123` med det viste
CT-ID:

```bash
pct exec 123 -- systemctl restart dobbelt-pi-hole
```

Genindlæs derefter browserfanen. Værktøjet opretter kun nye CT'er og opdaterer
ikke eksisterende installationer. Ved fejl bevares den nye CT til fejlsøgning,
og automatisk opstart forbliver deaktiveret.
[LXC-vejledningen](docs/LXC.md) (på engelsk) beskriver alle parametre, logs,
opdatering, backup og gendannelse.

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

Kør værktøjet, og genindlæs nginx igen efter ændringer i JSON-filen eller
`index.html`; den genererede Content Security Policy bruger hashværdier for
de indlejrede scripts.
[Konfigurationsvejledningen](docs/CONFIGURATION.md) (på engelsk) beskriver alle
felter, TLS, filrettigheder og opgradering fra tidligere versioner.

## Antal servere og navne

**`config.json` er den fælles kilde til installationsopsætningen.** Listen
`servers` indeholder to, tre eller fire objekter, hver med et fast `id`
(`"1"` til `"4"`), `label` og `apiUrl`. Antallet af objekter bestemmer
serverantallet, og rækkefølgen bestemmer visningsrækkefølgen. `verifyTls` er som
standard `true` for HTTPS-forbindelser til Pi-hole. Se
[eksemplet](config/config.example.json) og [JSON-skemaet](config/config.schema.json).

Angiv den direkte, endelige basisadresse til Pi-hole v6-API'et i `apiUrl` med
korrekt protokol (`http` eller `https`), værtsnavn, port og API-sti. Login- og
API-kald følger bevidst ikke HTTP-omdirigeringer. Et kald, der kræver en
omdirigering, mislykkes. Ret i så fald adressen i konfigurationen, og anvend
ændringen, før du prøver igen.

Serverfarverne følger deres ID: blå, gul, lilla og orange. Visningen tilpasser
sig antallet og skærmbredden med en maksimal sidebredde på 1900 px.
API-stierne genereres automatisk; Pi-hole-adresser skal ikke vedligeholdes
separat i nginx eller HTML.

Navne kan også ændres under **Indstillinger**. De gemmes i browserens
`localStorage` og erstatter de konfigurerede navne i netop den browser.
**Gendan standardnavne** gendanner de aktuelle standardnavne fra filen.
Antal installationer og deres adresser administreres i JSON-filen. En
webgrænseflade til lokal import, redigering og eksport af JSON er planlagt i
[#19](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/19). Beskyttet lagring
og aktivering på serveren er et særskilt senere trin,
[#20](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/20).

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

README-filerne indeholder opsætningsvejledninger på alle tre sprog. Kommentarer
og funktionsdokumentation i kildekode, kodeeksempler og nginx-eksempler er altid
på engelsk. Nginx-eksempelfilerne nedenfor har identisk indhold; deres
eksisterende filnavne bevares af hensyn til dokumentationslinks.

| Sprog | Dokumentation | nginx-eksempel |
| --- | --- | --- |
| English | [README.md](README.md) | [nginx.conf.example](nginx.conf.example) |
| Dansk | [README.DA.md](README.DA.md) | [nginx.conf.DA.example](nginx.conf.DA.example) |
| Deutsch | [README.DE.md](README.DE.md) | [nginx.conf.DE.example](nginx.conf.DE.example) |

## Aktuelle driftsbegrænsninger

- **Handlinger på tværs af installationer:** hver Pi-hole behandles
  uafhængigt; der er ingen fælles transaktion eller automatisk tilbageførsel.
  Domæner, lokal DNS, klienter og lister skelner mellem bekræftede ændringer,
  afvisninger, ikke-forbundne mål og ukendte skriveresultater. Hvert mål læses
  før en ændring. En mislykket læsning betyder ikke, at posten mangler, og
  ufærdige resultater rydder ikke formularen. Efter et tabt svar skal den
  aktuelle tilstand kontrolleres før et bevidst nyt forsøg; handlinger
  gentages aldrig automatisk. Se
  [#8](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/8).
- **Forespørgsler og browsertilstand:** almindelige API-kald samt login og
  logout har en browsergrænse på 15 sekunder; kontrol af gemte sessioner har
  10 sekunder. Gravity bruger først den almindelige frist, derefter to
  minutters inaktivitetstimeout og maksimalt 30 minutters samlet streaming.
  Sunde Pi-hole-instanser viser status og forespørgsler, selv om andre svar
  mangler; summer markeres som delvise. Skift af tidsrum eller fane afbryder
  forældede forespørgsler og markører. HTTP 401 ophæver kun den oprindelige
  session. Hvis kontrollen af en gemt session mislykkes på grund af en
  midlertidig forbindelsesfejl, beholdes SID som ubekræftet med mulighed for
  manuel kontrol. Almindelige API-netværksfejl bevarer SID uden at ændre en
  allerede etableret forbindelsestilstand. Logout sletter SID lokalt straks
  og oplyser, om fjernsessionen faktisk blev afsluttet. Se den engelske
  [driftsvejledning](docs/CONFIGURATION.md#browser-request-limits-and-session-state).
  Yderligere rettighedshåndtering findes i
  [#10](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/10);
  kladder, tastaturbetjening og flere browser-/mobiltests i
  [#11](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/11).
- **Konfigurationsændringer:** JSON valideres ved opstart, men en genstart med
  ugyldigt indhold kan gøre tjenesten utilgængelig. Behold en fungerende kopi
  af den private konfiguration. Forhåndsvalidering, koordineret aktivering og
  automatisk gendannelse er planlagt i
  [#12](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/12).
- **Overvågning:** `/healthz` bekræfter, at nginx svarer; det kontrollerer ikke,
  om Pi-hole kan nås, eller om API-login virker. En diagnosekommando er planlagt
  i [#13](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/13). Samlede
  statistikker kan være ufuldstændige, når en installation er utilgængelig;
  tydelig visning af dataenes alder og fuldstændighed samt valgfri automatisk
  opdatering er planlagt i
  [#22](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/22).
  Status for ekstern Nebula Sync vises endnu ikke; overvågning er planlagt i
  [#27](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/27).
- **Opdatering og gendannelse:** LXC-værktøjet opretter kun nye CT'er. Behold den
  nuværende installation og dens backups, mens du forbereder en erstatning.
  Se den [aktuelle vejledning til opdatering og backup](docs/LXC.md#updates-backup-and-recovery);
  afprøvet gendannelse af Docker/LXC er beskrevet i
  [#18](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/18), mens reel
  Proxmox-afprøvning og godkendelse behandles særskilt i
  [#24](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/24).

## Sikkerhed

- Løsningen er beregnet til personlig brug eller personer, du har tillid til.
  Alle, der kan logge ind, kan udføre de handlinger, deres Pi-hole-session
  tillader. Kontrolpanelet har ikke særskilte brugerkonti eller rollestyring.
- Login-sessioner gemmes i browserens `sessionStorage` og forsvinder, når fanen
  lukkes. Adgangskoder gemmes ikke.
- Kontrolpanelet neutraliserer værdier, der ikke er tillid til, før de vises,
  eksempelvis klientnavne, domæner og kommentarer.
- nginx tillader de indlejrede scripts med SHA-256-hashværdier i Content Security
  Policy og indlæser Chart.js lokalt. Svar indeholder også cachebegrænsninger,
  beskyttelse mod indlejring i rammer og `nosniff`-headere.
- Compose og den native LXC-tjeneste kører nginx uden rootrettigheder eller
  capabilities og forhindrer rettighedsforøgelse. API-proxyen fjerner browserens
  `Authorization`- og `Cookie`-headere før videresendelse til Pi-hole.
  Certifikatkontrol for HTTPS-forbindelser til Pi-hole er slået til som standard.
- Hvis kontrolpanelet afvikles på en Synology NAS, kan en profil til
  adgangskontrol i DSM begrænse adgangen til bestemte IP-adresser eller lokale
  netværk.

HTTPS på den foranstillede proxy beskytter browserforbindelsen. En
HTTP-forbindelse fra denne proxy til en fjern LXC-backend forbliver ukrypteret;
HTTPS-certifikatkontrol for nginx-forbindelser til Pi-hole er endnu en særskilt
indstilling. Begræns direkte adgang til backend som beskrevet i
[LXC-netværksvejledningen](docs/LXC.md#access-and-firewall-placement).
En afprøvet installationsprofil med beskyttede forbindelser er planlagt i
[#15](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/15). Logopbevaring og
færre følsomme oplysninger i adgangslogs er planlagt i
[#14](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/14); den nuværende
logning følger Docker-værtens logindstillinger, CT'ens journal-/syslogindstillinger
eller den eksisterende nginx-logkonfiguration ved manuel installation.

Kontrolpanelet bør ikke eksponeres direkte på internettet uden passende
adgangskontrol foran det.

## Implementerede milepæle

Disse versioner beskriver implementerede milepæle i kildekoden og er ikke et
katalog over offentliggjorte udgivelsesfiler.

- **v1.1.005:** Komplet dansk og engelsk brugerflade og dokumentation
- **v1.2.006:** Understøttelse af to, tre eller fire Pi-hole-installationer
- **v1.3.007:** Nøglebaseret dansk, engelsk og tysk lokalisering samt regressionstests — [PR #1](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/1)
- **v1.4.008:** Ekstern JSON-konfiguration, genererede API-proxyer og et Docker-image, der kan bygges lokalt — [PR #3](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/3)
- **v1.5.009:** Automatisk native installation i Proxmox LXC samt stærkere nginx-isolering og CSP — [PR #5](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/5)
- **Efterfølgende rettelse på `main`:** API- og loginomdirigeringer afvises — [#7](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/7), flettet ind med [PR #25](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/25)
- **Driftssikre resultater på `main`:** Korrekt læse-/skriveresultat pr. Pi-hole, sikre gentagelser og bevarede klientkladder — [#8](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/8), flettet ind med [PR #29](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/29).
- **Pålidelige API-sessioner og forespørgsler på `main`:** Tidsgrænser for API og Gravity, uafhængige Pi-hole-resultater og sikker håndtering af forældede sessioner — [#9](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/9), flettet ind med [PR #31](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/31); [main-CI](https://github.com/Daniel-Dietz/dobbelt-pi-hole/actions/runs/39106508075) bestod.

## Roadmap

[Oversigten i #6](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/6) er den
gældende kilde til fremdrift. **Status 2026-10-18: 3 af 19 arbejdspakker
afsluttet; 16 åbne. Næste: #10.** Tabellen følger den anbefalede
arbejdsrækkefølge. Kun kolonnen med forudsætninger angiver tekniske afhængigheder
inden for dette roadmap; en tidligere række er ikke automatisk en
forudsætning. De enkelte issues fastlægger omfang og acceptkriterier. Der er
endnu ikke tildelt fremtidige versionsnumre eller leveringsdatoer.

Overvågning af Nebula Sync (#27) er tilføjet som trin **16a**, efter #22 og
før #23. De oprindelige trinnumre bevares; #27 tilføjer ingen forudsætning
for #23 eller #24.

| Rækkefølge | Issue og omfang | Status | Forudsætninger |
| --- | --- | --- | --- |
| 01 | [#7](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/7) — Afvis API- og loginomdirigeringer til andre installationers ruter | Afsluttet | Ingen |
| 02 | [#8](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/8) — Læse- og skriveresultater pr. installation, delvise fejl og ukendte datatilstande | Afsluttet | #7 |
| 03 | [#9](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/9) — Begræns forespørgsler, beskyt mod indlæsningskapløb i forespørgselsloggen, og adskil sessions- og forbindelsestilstande | Afsluttet | #7, #8 |
| 04 | [#10](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/10) — API-kompatibilitet, rettigheder samt fejlslagen eller ukendt blokeringsstatus | Åben — næste | #9 |
| 05 | [#11](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/11) — Bevar kladder, forbedr tastaturbetjening, og udvid browser- og mobiltests | Åben | #8, #9 |
| 06 | [#12](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/12) — Forhåndskontrol af konfiguration, koordineret aktivering og tilbageførsel | Åben | Ingen |
| 07 | [#13](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/13) — Læsende diagnose af konfiguration, tjeneste og forbindelser | Åben | #12 |
| 08 | [#14](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/14) — Logopbevaring og færre følsomme oplysninger i nginx-adgangslogs | Åben | Ingen |
| 09 | [#15](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/15) — Beskyttet netværks- og TLS-installation med fjern LXC-backend | Åben | #13 |
| 10 | [#16](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/16) — Centrale afhængighedsmetadata, fastlåste CI-referencer og opdateringskontroller | Åben | #7 |
| 11 | [#17](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/17) — Gennemgåede udgivelser, Docker-images, native installationsfiler og versionsidentitet | Åben | #12, #13, #16 |
| 12 | [#18](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/18) — Afprøvet opdatering, tilbageførsel og portabel gendannelse af Docker/LXC | Åben | #12, #13, #17 |
| 13 | [#19](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/19) — Flersproget lokal JSON-konfigurationsassistent med import og eksport | Åben | #10, #11, #12 |
| 14 | [#20](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/20) — Beskyttet lagring og aktivering af central konfiguration på serveren | Åben | #12, #13, #15, #18, #19 |
| 15 | [#21](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/21) — Midlertidig pause af blokering med timer på Pi-hole-serveren | Åben | #8, #9, #10 |
| 16 | [#22](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/22) — Dataenes alder og fuldstændighed samt ressourcebesparende valgfri automatisk opdatering | Åben | #8, #9, #10, #21 |
| 16a | [#27](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/27) — Valgfri læsende overvågning af Nebula Sync med dokumenterede resultater for kørsler og replikaer | Åben | #12, #13, #22 |
| 17 | [#23](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/23) — Sammenligning af installationer, forhåndsvisning af synkronisering og udvalgte ændringer | Åben | #8, #9, #10, #22 |
| 18 | [#24](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/24) — Afprøvning og godkendelse af installation og gendannelse på en rigtig Proxmox-testvært | Åben | #12, #13, #15, #17, #18 |

Den lokale assistent i #19 skal eksportere JSON; administration på serveren
er særskilt afgrænset i #20. Ingen af delene findes på den nuværende side
**Indstillinger**. Synkronisering mellem installationer i #23 forbliver en
udtrykkelig brugerhandling; uovervåget replikering og DNS-failover er uden for
det planlagte omfang.

Overvågning af Nebula Sync i #27 er planlagt som en læsende integration med en
tjeneste, der er installeret, konfigureret og aktiveret separat. Den kræver også
en fuldstændig konfiguration i kontrolpanelet og udtrykkelig aktivering. Den er
som standard deaktiveret og foretager ingen statusforespørgsler, før den
aktiveres. Seneste bekræftede afsluttede succes, dataenes alder og resultater
pr. replika vises kun, når statuskilden dokumenterer dem; manglende oplysninger
forbliver ukendte. Fejl efter aktivering forbliver synlige. Integrationen
starter ikke synkronisering, ændrer ikke konfiguration og leverer ikke failover.

## Kontrol og test

[i18n-workflowet](.github/workflows/i18n.yml) dækker oversættelsesadfærd,
Chromium-tests med kontrollerede testdata, genereret konfiguration og
Docker-integration samt Proxmox-CLI-fixtures og installation i en Debian 13
systemd-testcontainer. Disse kontroller dokumenterer ikke reel installation
eller gendannelse på Proxmox. Firefox, WebKit og målrettede mobiltests er
fortsat planlagt i #11.

Fra projektets rodmappe kan kontrollerne uden ekstra afhængigheder køres med
Node.js 24 og Python:

```bash
node --test tests/i18n.test.cjs
python3 -m unittest discover -s tests -p 'test_render_config.py' -v
python3 -m unittest discover -s tests -p 'test_create_lxc.py' -v
```

Se [opsætning af browsertests](docs/I18N.md#verification),
[Docker-integrationstests](docs/CONFIGURATION.md#upgrading-and-checks) og
[native gæstetests](docs/LXC.md#verification-scope) for deres afhængigheder og
kommandoer. Node.js, npm og Playwright er ikke nødvendige på et installeret
kontrolpanel.

## Bidrag

Issues og pull requests er velkomne. Bidrag kan blandt andet være fejlrettelser,
forslag og oversættelser til flere sprog. Brug de samme meddelelsesnøgler og
navngivne parametre i alle sprogkataloger, og medtag oversættelser af statisk
tekst, dynamiske tilstande og tilgængelighedstekster.
Se [oversættelsesvejledningen](docs/I18N.md) (på engelsk) for hjælpefunktioner,
tilføjelse af sprog og kørsel af de automatiske kontroller.

Hold den vedligeholdte kildekode læsbar med beskrivende navne og tydelig programlogik.
Dokumentér hver funktion, også indlejrede callbacks og test-fixtures, ved dens
definition med en nyttig engelsk beskrivelse.
[Udviklingsvejledningen](docs/DEVELOPMENT.md) (på engelsk) forklarer
dokumentationsreglerne, kildekodens opbygning og kontrollerne.

Kontrollér aktuel `main`, det relevante issue, dets afhængigheder og eksisterende
PR'er, før du begynder på en arbejdspakke. Følg arbejdsgangen i
[#6](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/6): én
implementerings-PR ad gangen, relevante tests og opdateringer på DA/EN/DE,
Codex-review af PR'ens endelige commit og vellykket CI før merge, derefter
dokumentation af vellykket main-CI før lukning af issuet. Hold roadmap i alle
tre README-filer i overensstemmelse med oversigten, når arbejde afsluttes.
En dokumentationsændring alene afslutter ikke et funktionsissue.

## Licens

Copyright © 2023–2026 Christian Kragh Jessen  
https://christiankragh.dk

Projektet blev oprindeligt udviklet til Pi-hole v5 i 2023 og opdateret til
Pi-hole v6 i 2026.

Projektet er udgivet under MIT-licensen og må bruges, kopieres, ændres og
videredistribueres i overensstemmelse med licensens vilkår. Se filen `LICENSE`.

Docker-imaget indeholder Chart.js 4.4.1 og dets MIT-licens i
`/usr/share/licenses/chart.js/LICENSE`. LXC-værktøjet henter og verificerer også
grafbiblioteket og licensen automatisk. Ved manuel installation hentes Chart.js
separat som beskrevet ovenfor. Chart.js er et selvstændigt tredjepartsprojekt.
