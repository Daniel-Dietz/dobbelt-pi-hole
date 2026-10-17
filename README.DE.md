# Doppel-Pi-hole-Dashboard

[English](README.md) | [Dansk](README.DA.md) | **Deutsch**

Ein schlankes Dashboard zur gemeinsamen Verwaltung von zwei, drei oder vier
Pi-hole-v6-Instanzen. Der Browser lädt `index.html`, eine externe
JSON-Konfiguration und eine lokale Chart.js-Datei. Ein Anwendungsbackend,
eine Datenbank oder ein Frontend-Build-Prozess sind nicht erforderlich.
Die Instanzen werden in einer zentralen JSON-Datei konfiguriert. Ein kleines
Python-Werkzeug erzeugt daraus die öffentliche Browserkonfiguration und
nginx-Proxy-Routen. Unter Docker und beim nativen Proxmox-LXC-Dienst geschieht
dies automatisch beim Start.

Das Dashboard bietet:

- Zusammengefasste Statistiken und Diagramme
- Ein gemeinsames Abfrageprotokoll mit Filter- und Sortierfunktionen
- Verwaltung erlaubter und gesperrter Domains
- Lokale DNS-Einträge mit übersichtlicher Anzeige der Unterschiede zwischen den Instanzen
- Bekannte Clients und Vorschläge für unbekannte Geräte
- Verwaltung von Sperr- und Freigabelisten (Adlists)
- Gravity-Aktualisierung pro Instanz mit Anzeige des letzten Aktualisierungszeitpunkts
- Aktionen für eine einzelne oder alle aktiven Instanzen
- Eine dänische, englische und deutsche Benutzeroberfläche

Die Pi-hole-Instanzen bleiben eigenständige DNS-Server. Das Projekt stellt
weder Failover noch eine virtuelle IP-Adresse, einen primären oder sekundären
Server oder eine automatische Replikation im Hintergrund bereit. Ziel ist es,
die relevanten Einstellungen bequem über ein gemeinsames Dashboard
einheitlich zu verwalten.

![Pi-hole-Dashboard](images/dashboard.png)

## Bewusst schlank

Das Dashboard ist bewusst einfach aufgebaut:

- Eine HTML-Datei mit HTML, CSS und JavaScript
- Kein Anwendungsbackend
- Keine Datenbank
- Kein Frontend-Build-Prozess
- Python für die Installation und zum Erzeugen der Konfiguration bei Installation oder Dienststart
- Serveradressen, Anzahl, Standardnamen und Standardsprache in einer externen JSON-Datei
- Eigene Namen und Anzeigeeinstellungen lokal im Browser
- Direkte Kommunikation mit den Pi-hole-v6-APIs über nginx

Chart.js wird als separate lokale Datei eingebunden und ausschließlich für
die Diagramme verwendet.

## Voraussetzungen

- Zwei bis vier Pi-hole-Instanzen der Version **v6** mit REST-API. Das Dashboard
  funktioniert nicht mit der alten PHP-API von Pi-hole v5.
- Docker mit Compose, **Proxmox VE 9 auf amd64** für den automatischen LXC-Installer
  oder nginx und Python ab Version 3.10 für die manuelle Installation.
- Netzwerkzugriff vom nginx des Dashboards auf alle konfigurierten Pi-hole-APIs.
- Ein App-Passwort für jede Pi-hole-Instanz. Dieses wird in der jeweiligen
  Pi-hole-Verwaltungsoberfläche unter **Settings → API** erstellt.

## Einrichtung mit Docker

Führe im lokal ausgecheckten Repository zunächst Folgendes aus:

```bash
cp config/config.example.json config/config.json
```

Trage in `config/config.json` die Namen und API-Adressen deiner zwei bis vier
Instanzen ein und starte anschließend das Dashboard:

```bash
docker compose up --build -d
docker compose logs dashboard
```

Öffne **http://localhost:8080** und melde dich mit dem jeweiligen App-Passwort
bei jeder aktiven Pi-hole-Instanz an. Compose bindet den Port standardmäßig
nur an die Loopback-Adresse des Docker-Hosts. Verwende einen HTTPS-Reverse-Proxy
auf diesem Host oder passe die Portbindung in `compose.yaml` bewusst an,
wenn das Dashboard direkt im lokalen Netzwerk erreichbar sein soll.
[nginx.conf.DE.example](nginx.conf.DE.example) zeigt einen optionalen
vorgeschalteten HTTPS-Proxy.

Das Verzeichnis `./config` wird unter `/config` schreibgeschützt eingebunden.
Beim Start prüft der Container `/config/config.json`, erzeugt beide
Konfigurationen und prüft nginx, bevor der Dienst startet. Bei fehlender oder
ungültiger Konfiguration bricht der Start ab. Chart.js ist im Image enthalten;
beim Start werden keine externen Dateien heruntergeladen.

Starte den Container nach Änderungen an der Konfiguration neu und lade den
Dashboard-Tab erneut:

```bash
docker compose restart dashboard
```

## Automatische Installation in Proxmox LXC

Der Installer erstellt einen neuen **unprivilegierten Debian-13-LXC** und
installiert nginx, Python, das Dashboard sowie Chart.js direkt darin. Er wird
als **root auf dem Proxmox-VE-9-Host** ausgeführt. Die Anwendung läuft anschließend
als eigener Benutzer `dobbelt-pi-hole` im CT; Docker ist dafür nicht erforderlich.

### 1. Projekt und Pi-hole-Konfiguration vorbereiten

Lege eine vollständige lokale Kopie des Projekts auf dem Proxmox-Host ab.
Mit installiertem Git kannst du sie so herunterladen:

```bash
git clone https://github.com/Daniel-Dietz/dobbelt-pi-hole.git /root/dobbelt-pi-hole
cd /root/dobbelt-pi-hole
cp config/config.example.json config/config.json
```

Bearbeite `config/config.json` und trage die Namen und API-Adressen deiner
zwei bis vier Pi-hole-Instanzen ein. App-Passwörter gehören nicht in diese
Datei; du gibst sie später im Dashboard ein. Die
[Konfigurationsanleitung](docs/CONFIGURATION.md) erläutert alle Felder.

### 2. Installation zunächst prüfen

Passe `local-lvm`, `local` und `vmbr0` an die vorhandenen Speicher und die
aktive Bridge deines Proxmox-Nodes an. Prüfe den Plan mit:

```bash
python3 tools/create_lxc.py \
  --config /root/dobbelt-pi-hole/config/config.json \
  --storage local-lvm \
  --template-storage local \
  --bridge vmbr0 \
  --hostname dobbelt-pi-hole \
  --dry-run
```

`--dry-run` prüft die lokalen Dateien und das Proxmox-Inventar und zeigt die
geplanten Befehle. Es erstellt keinen CT, lädt nichts herunter und ändert
nichts am Host. Die automatische Template-Auswahl benötigt einen vorhandenen
Proxmox-Katalog. Falls dieser leer ist, aktualisiere ihn separat mit
`pveam update` und wiederhole die Prüfung.

### 3. Neuen CT erstellen und Anwendung installieren

Starte die Installation mit denselben Parametern ohne `--dry-run`:

```bash
python3 tools/create_lxc.py \
  --config /root/dobbelt-pi-hole/config/config.json \
  --storage local-lvm \
  --template-storage local \
  --bridge vmbr0 \
  --hostname dobbelt-pi-hole
```

Standardmäßig verwendet der Installer eine clusterweit freie CT-ID, das neueste
Debian-13-Standard-Template für amd64 aus dem Proxmox-Katalog und DHCP. Vorgesehen
sind **1 CPU-Kern, 512 MiB RAM, 0 MiB Swap und 4 GiB Speicher**. Bei der echten
Installation wird der Template-Katalog aktualisiert; das gewählte Template
wird nur heruntergeladen, wenn es noch nicht im Cache liegt.

Sobald Befehle im CT möglich sind, wartet der Installer bis zu **180 Sekunden**
auf eine nutzbare bzw. die konfigurierte IPv4-Adresse an `eth0`, DNS-Auflösung
für `deb.debian.org` und `raw.githubusercontent.com` sowie eine TCP-Verbindung
zu `cdnjs.cloudflare.com:443`. Erst danach folgen Dateiübertragung und
Paketinstallation. Bei einem Timeout bleiben der neue CT und sein Löschschutz
erhalten; automatischer Start bleibt aus und der Installer versucht, den CT zu
stoppen. Prüfe dann DHCP bzw. statische Adresse, Gateway, DNS und Firewallregeln.

Weitere Angaben kannst du an den Aufruf anhängen:

| Parameter | Beispiel und Bedeutung |
| --- | --- |
| `--ctid` | `--ctid 123` verwendet eine bestimmte freie CT-ID. |
| `--ipv4` und `--gateway` | `--ipv4 192.168.1.50/24 --gateway 192.168.1.1` setzt eine statische Adresse. |
| `--vlan` | `--vlan 123` setzt das VLAN-Tag. |
| `--nameserver` | `--nameserver 192.168.1.1` legt einen DNS-Server fest; für mehrere Server wiederholen. |
| `--cores`, `--memory`, `--swap`, `--disk` | Ändern CPU-Kerne, RAM/Swap in MiB und Speicher in GiB. |
| `--template` | Wählt ein vorhandenes Template auf `--template-storage` über seine vollständige Proxmox-Volume-ID. |

Der Installer verändert keine bestehenden CTs und baut weder das Host-Netzwerk
noch Firewallregeln um. Automatischer CT-Start beim Booten wird erst nach
erfolgreicher Installation aktiviert. Bei einem Fehler bleibt der neue CT zur
Diagnose erhalten, zunächst ohne automatischen Start. Der Installer ist für
**Neuinstallationen** vorgesehen und enthält keinen Updater für bestehende CTs.
Auch vorhandene nginx-Pakete, Dienste, Maskierungen oder Konfigurationen im Gast
führen vor Änderungen zum Abbruch. Verwende ein frisches Debian-13-Standard-Template;
ein bereits vorhandener Webserver wird nicht übernommen.
Der CT erhält außerdem einen Löschschutz (`protection=1`), der auch nach Erfolg
oder Fehler aktiv bleibt. Für ein bewusstes späteres Entfernen musst du ihn
zuerst mit `pct set 123 --protection 0` aufheben; ersetze `123` durch die zuvor
geprüfte CT-ID. Der Installer löscht selbst keine CTs.

### 4. Dashboard öffnen und betreiben

Der native Dienst lauscht auf **`0.0.0.0:8080` innerhalb des CT**. Verwende die
am Ende ausgegebene CT-Adresse, beispielsweise `http://192.168.1.50:8080`.
Für den regulären Zugriff empfiehlt sich ein vorgeschalteter HTTPS-Proxy mit
geeigneter Zugriffsbeschränkung. Die Aktivierung des Firewallflags am
CT-Netzwerkadapter erzeugt **keine fertigen Firewallregeln**.

Läuft dein HTTPS-Proxy außerhalb des CT, ersetzt du im
[nginx-Beispiel](nginx.conf.DE.example) das Ziel `127.0.0.1:8080` durch die
CT-Adresse, beispielsweise `192.168.1.50:8080`. Beschränke den Zugriff auf
CT-Port 8080 mit deiner vorhandenen Proxmox-Firewall auf den Proxy bzw. die
vorgesehenen vertrauenswürdigen Clients. Die Pi-hole-Adressen bleiben
weiterhin ausschließlich in der zentralen JSON-Datei.

Diese Datei liegt nach der Installation **im CT** unter
`/etc/dobbelt-pi-hole/config.json`. Die ursprüngliche Kopie auf dem Host wird
nicht laufend synchronisiert. Mit `pct enter 123` öffnest du eine Shell im CT;
ersetze `123` durch die ausgegebene CT-ID. Nach einer Konfigurationsänderung
kannst du den Dienst vom Proxmox-Host aus neu starten und seine Logs anzeigen:

```bash
pct exec 123 -- systemctl restart dobbelt-pi-hole
pct exec 123 -- journalctl -u dobbelt-pi-hole -n 100 --no-pager
```

Lade anschließend den Dashboard-Tab neu. Chart.js und dessen Lizenz werden bei
der Installation heruntergeladen und per SHA-256 geprüft; Dienststarts brauchen
keine erneuten Downloads. Der [LXC-Leitfaden](docs/LXC.md) (auf Englisch) enthält
die vollständige Parameterübersicht sowie Hinweise zu Backup, Wiederherstellung,
Updates und Fehlerbehebung.

## Manuelle Einrichtung mit nginx

1. Kopiere `index.html` in das Webverzeichnis, beispielsweise
   `/srv/web/pihole-dashboard/index.html`, und lade Chart.js daneben herunter:

   ```bash
   curl --fail --location -o /srv/web/pihole-dashboard/chart.umd.min.js \
     https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
   ```

2. Kopiere [config/config.example.json](config/config.example.json) an einen
   privaten Speicherort wie `/etc/dobbelt-pi-hole/config.json` und passe Namen
   und API-Adressen an. Diese Quelldatei gehört außerhalb des Webverzeichnisses.
3. Erzeuge die öffentliche Konfiguration und die nginx-Routen aus derselben Datei:

   ```bash
   python3 tools/render_config.py \
     --config /etc/dobbelt-pi-hole/config.json \
     --output-dir /etc/nginx/dobbelt-pi-hole \
     --web-root /srv/web/pihole-dashboard \
     --listen-address 127.0.0.1
   ```

4. Ergänze im vorhandenen `http`-Block von nginx die Zeile
   `include /etc/nginx/dobbelt-pi-hole/nginx.conf;`. Der erzeugte Server lauscht
   auf `127.0.0.1:8080`. [nginx.conf.DE.example](nginx.conf.DE.example) dient bei Bedarf
   als vorgeschalteter HTTPS-Proxy; passe Domain und Zertifikatspfade an.
5. Prüfe die Konfiguration und lade nginx neu. Öffne anschließend das Dashboard
   und melde dich an:

   ```bash
   nginx -t && systemctl reload nginx
   ```

Führe nach Änderungen an der JSON-Datei oder `index.html` den Generator erneut
aus und lade nginx neu; die erzeugte Content Security Policy verwendet Hashwerte
der eingebetteten Skripte. Die [Konfigurationsanleitung](docs/CONFIGURATION.md) (auf Englisch)
erläutert alle Felder, TLS, Dateiberechtigungen und die Migration älterer Installationen.

## Serveranzahl und Namen

**`config.json` ist die einzige Quelle für die Instanzkonfiguration.** Das Array
`servers` enthält zwei, drei oder vier Objekte mit einer festen `id` (`"1"` bis
`"4"`), `label` und `apiUrl`. Seine Länge bestimmt die Anzahl der Server,
seine Reihenfolge die Anzeigereihenfolge. Für HTTPS-Verbindungen zu Pi-hole
ist `verifyTls` standardmäßig `true`. Siehe
[Beispieldatei](config/config.example.json) und [JSON-Schema](config/config.schema.json).

Die Serverfarben sind an die IDs gebunden: Blau, Gelb, Violett und Orange.
Das Layout passt sich an die Serveranzahl und Bildschirmbreite an, bis zu
maximal 1900 Pixeln Seitenbreite. Die API-Routen werden automatisch erzeugt;
es gibt keine zweite Liste von Pi-hole-Adressen in nginx oder HTML zu pflegen.

Namen lassen sich außerdem unter **Einstellungen** ändern. Sie werden im
`localStorage` des Browsers gespeichert und ersetzen dort die konfigurierten
Standardnamen. **Standardnamen wiederherstellen** übernimmt die aktuellen
Vorgaben aus der Datei. Anzahl und Adressen der Instanzen werden in der
JSON-Datei verwaltet. Eine Weboberfläche zum Bearbeiten dieser zentralen
Konfiguration ist für eine spätere Version geplant.

Beim Upgrade von v1.3.007 oder älter überträgst du die Instanzangaben aus HTML
und nginx in die JSON-Datei und ersetzt die bisherigen API-Proxy-Blöcke durch
die erzeugte Konfiguration. Vorhandene lokale Anzeigenamen werden übernommen;
pro Instanz ist jedoch eine **einmalige erneute Anmeldung** erforderlich,
weil Sitzungen jetzt an das konfigurierte API-Ziel gebunden sind. Ändert sich
später eine API-Adresse, meldet ein alter Tab die Konfigurationsänderung und
muss vor weiteren Anfragen neu geladen werden. Umbenennen oder Umsortieren
derselben Instanzen ändert ihre API-Identität nicht.

## Sprachen

Die Benutzeroberfläche ist auf **English**, **Dansk** und **Deutsch**
verfügbar. Die Sprachauswahl oben im Dashboard stellt die Oberfläche sofort
um, einschließlich Dialogtexten, dynamischen Meldungen, Tabellen und
Diagrammen. Zahlen, Prozentwerte, Datum und Uhrzeit werden entsprechend der
ausgewählten Sprache formatiert.

Beim Öffnen wird die Sprache in dieser Reihenfolge ermittelt:

1. Eine unterstützte Sprache, die zuvor im Browser ausgewählt und im
   `localStorage` gespeichert wurde.
2. Die konfigurierte `defaultLanguage`, sofern sie `da`, `en` oder `de` ist.
   Der Standardwert `auto` führt weiter zur Sprachauswahl des Browsers.
3. Die erste unterstützte Sprache aus der nach Präferenz sortierten
   Sprachliste des Browsers. Regionale Varianten wie `de-DE`, `de-AT`,
   `en-GB` und `da-DK` werden unterstützt.
4. Englisch, falls keine unterstützte Sprache gefunden wird.

Die Übersetzungen verwenden feste Nachrichtenschlüssel und benannte
Parameter in vollständigen `en`-, `da`- und `de`-Sprachkatalogen direkt in
`index.html`. Zusätzliche Sprachen benötigen weder Backend noch Build-Schritt
oder weitere Laufzeitabhängigkeiten. Servernamen, Domains, Clientnamen,
Kommentare und andere von Benutzern oder den Pi-hole-APIs gelieferte Werte
bleiben beim Sprachwechsel unverändert.

Einrichtungsanleitung und nginx-Beispiele sind ebenfalls in allen drei
Sprachen verfügbar:

| Sprache | Dokumentation | nginx-Beispiel |
| --- | --- | --- |
| English | [README.md](README.md) | [nginx.conf.example](nginx.conf.example) |
| Dansk | [README.DA.md](README.DA.md) | [nginx.conf.DA.example](nginx.conf.DA.example) |
| Deutsch | [README.DE.md](README.DE.md) | [nginx.conf.DE.example](nginx.conf.DE.example) |

## Sicherheit

- Das Dashboard ist für den persönlichen Einsatz oder für einen
  vertrauenswürdigen Benutzerkreis vorgesehen. Jede Person, die sich anmelden
  kann, erhält administrativen Zugriff auf die verbundenen Pi-hole-Instanzen.
- Anmeldesitzungen werden im `sessionStorage` des Browsers gespeichert und
  beim Schließen des Tabs entfernt. Passwörter werden nicht gespeichert.
- Nicht vertrauenswürdige Werte wie Clientnamen, Domains und Kommentare
  werden vor der Anzeige maskiert.
- nginx erlaubt eingebettete Anwendungsskripte über SHA-256-Hashes in der Content
  Security Policy und lädt Chart.js lokal. Die Antworten enthalten außerdem
  Cachebeschränkungen, Schutz vor Einbettung in Frames und `nosniff`-Header.
- Compose und der native LXC-Dienst führen nginx ohne Rootrechte oder
  Capabilities aus und verhindern eine Rechteerhöhung. Der API-Proxy entfernt
  `Authorization`- und `Cookie`-Header des Browsers vor der Weiterleitung an
  Pi-hole; die Zertifikatsprüfung für HTTPS-Ziele ist standardmäßig aktiv.
- Beim Betrieb auf einem Synology NAS kann ein DSM-Zugriffssteuerungsprofil
  den Zugriff auf bestimmte IP-Adressen oder lokale Netzwerke beschränken.

Das Dashboard sollte ohne vorgeschaltete, geeignete Zugriffskontrolle nicht
direkt aus dem Internet erreichbar sein.

## Roadmap

- **v1.1.005:** Vollständige dänische und englische Oberfläche und Dokumentation
- **v1.2.006:** Unterstützung für zwei, drei oder vier Pi-hole-Instanzen
- **v1.3.007:** Schlüsselbasierte Mehrsprachigkeit mit vollständiger dänischer, englischer und deutscher Oberfläche und Dokumentation
- **v1.4.008:** Externe JSON-Konfiguration, erzeugte API-Routen und Docker-Image
- **v1.5.009:** Automatische native Proxmox-LXC-Installation, stärkere nginx-Isolierung und CSP
- **Geplant:** Weboberfläche zum Bearbeiten der zentralen Instanzkonfiguration

## Mitwirken

Issues und Pull Requests sind willkommen. Mögliche Beiträge sind
Fehlerbehebungen, Vorschläge und Übersetzungen in weitere Sprachen. Verwende
in allen Sprachkatalogen dieselben Nachrichtenschlüssel und benannten
Parameter. Berücksichtige statische Texte, dynamische Zustände und
Beschriftungen für die Barrierefreiheit.
Der [Übersetzungsleitfaden](docs/I18N.md) (auf Englisch) beschreibt die
Hilfsfunktionen, das Hinzufügen weiterer Sprachen und die automatisierten
Prüfungen.

## Lizenz

Copyright © 2023–2026 Christian Kragh Jessen  
https://christiankragh.dk

Das Projekt wurde ursprünglich 2023 für Pi-hole v5 entwickelt und 2026 für
Pi-hole v6 aktualisiert.

Das Projekt steht unter der MIT-Lizenz und darf gemäß deren Bedingungen
verwendet, kopiert, verändert und weiterverbreitet werden. Siehe `LICENSE`.

Das Docker-Image enthält Chart.js 4.4.1 und dessen MIT-Lizenz unter
`/usr/share/licenses/chart.js/LICENSE`. Der LXC-Installer lädt und prüft die
Diagrammbibliothek und ihre Lizenz ebenfalls automatisch. Bei manueller
Installation wird Chart.js wie oben beschrieben separat heruntergeladen.
Chart.js ist ein unabhängiges Drittanbieterprojekt.
