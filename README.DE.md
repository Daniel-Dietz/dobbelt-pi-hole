# Doppel-Pi-hole-Dashboard

[English](README.md) | [Dansk](README.DA.md) | **Deutsch**

Ein schlankes Dashboard zur gemeinsamen Verwaltung von zwei, drei oder vier
Pi-hole-v6-Instanzen. Die Anwendung besteht aus einer einzigen eigenständigen
`index.html` und benötigt weder Backend noch Datenbank oder Build-Prozess.
Der Browser kommuniziert über einen nginx-Reverse-Proxy direkt mit den
REST-APIs der aktiven Pi-hole-Instanzen.

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
- Kein Backend
- Keine Datenbank
- Kein Build-Prozess
- Kein Node.js, PHP oder Python
- Serveranzahl und Standardnamen in der HTML-Datei; eigene Namen und Anzeigeeinstellungen lokal im Browser
- Direkte Kommunikation mit den Pi-hole-v6-APIs über nginx

Chart.js wird als separate lokale Datei eingebunden und ausschließlich für
die Diagramme verwendet.

## Voraussetzungen

- Zwei bis vier Pi-hole-Instanzen der Version **v6** mit REST-API. Das Dashboard
  funktioniert nicht mit der alten PHP-API von Pi-hole v5.
- nginx oder ein vergleichbarer Reverse-Proxy vor dem Dashboard. Anfragen an
  `/api1/...` und `/api2/...` sowie bei Bedarf `/api3/...` und `/api4/...`
  müssen an die jeweilige Pi-hole-Instanz weitergeleitet werden. Dadurch
  werden CORS-Probleme vermieden.
- Ein App-Passwort für jede Pi-hole-Instanz. Dieses wird in der jeweiligen
  Pi-hole-Verwaltungsoberfläche unter **Settings → API** erstellt.

## Einrichtung

1. Kopiere `index.html` in das von nginx bereitgestellte Verzeichnis, zum
   Beispiel `/srv/web/pihole-dashboard/index.html`.
2. Lade Chart.js in dasselbe Verzeichnis herunter:

   ```bash
   cd /srv/web/pihole-dashboard
   curl -o chart.umd.min.js https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
   ```

3. Übernimm `nginx.conf.DE.example` in deine nginx-Konfiguration.
4. Passe Domain, Pi-hole-Adressen, Zertifikatspfade und Webverzeichnis an.
   Setze `DEFAULT_SERVER_COUNT` in `index.html` auf `2`, `3` oder `4`.
   Im nginx-Beispiel sind `/api1/` und `/api2/` standardmäßig aktiv.
   Entferne bei drei Instanzen die Kommentarzeichen vor dem gesamten
   `/api3/`-Block und passe seine Adresse an. Aktiviere bei vier Instanzen
   zusätzlich den `/api4/`-Block und passe auch dessen Adresse an.
5. Prüfe die Konfiguration und lade nginx neu:

   ```bash
   nginx -t && systemctl reload nginx
   ```

6. Öffne die Dashboard-URL und melde dich mit den jeweiligen App-Passwörtern
   bei allen aktiven Pi-hole-Instanzen an.

## Serveranzahl und Namen

Die Anzahl der aktiven Pi-hole-Instanzen wird **ausschließlich in `index.html`**
festgelegt:

```js
const DEFAULT_SERVER_COUNT = 2; // 2, 3 oder 4
```

Es werden die ersten zwei, drei oder vier Einträge aus `DEFAULT_SERVERS`
verwendet. Die API-Pfade lauten `/api1`, `/api2`, `/api3` und `/api4`.
Konfiguriere in nginx für jede aktive Instanz eine entsprechende
Proxy-Weiterleitung. Die tatsächlichen Hostnamen oder IP-Adressen der
Pi-hole-Instanzen werden in nginx eingetragen, nicht in den Einstellungen
des Browsers.

Die Standardnamen für alle Browser werden über `label` in `DEFAULT_SERVERS`
festgelegt:

```js
const DEFAULT_SERVERS = [
    { id: "1", label: "Pi-hole 1", base: "/api1", color: "c-1", chip: "s1" },
    { id: "2", label: "Pi-hole 2", base: "/api2", color: "c-2", chip: "s2" },
    { id: "3", label: "Pi-hole 3", base: "/api3", color: "c-3", chip: "s3" },
    { id: "4", label: "Pi-hole 4", base: "/api4", color: "c-4", chip: "s4" },
];
```

Die Serverfarben sind in dieser Reihenfolge Blau, Gelb, Violett und Orange.
Das Layout passt sich an die konfigurierte Serveranzahl und die Bildschirmbreite
an. Die maximale Seitenbreite beträgt 1900 Pixel.

Die Namen der aktiven Instanzen lassen sich auch unter **Einstellungen**
ändern. Diese Namen werden im `localStorage` des Browsers gespeichert und
ersetzen dort die Standardnamen aus der Datei. Serveranzahl und API-Pfade
lassen sich unter Einstellungen nicht ändern. Änderungen der Standardnamen
in der Datei überschreiben keine lokal gespeicherten Namen.

## Sprachen

Die Benutzeroberfläche ist auf **English**, **Dansk** und **Deutsch**
verfügbar. Die Sprachauswahl oben im Dashboard stellt die Oberfläche sofort
um, einschließlich Dialogtexten, dynamischen Meldungen, Tabellen und
Diagramme. Zahlen, Prozentwerte, Datum und Uhrzeit werden entsprechend der
ausgewählten Sprache formatiert.

Beim Öffnen wird die Sprache in dieser Reihenfolge ermittelt:

1. Eine unterstützte Sprache, die zuvor im Browser ausgewählt und im
   `localStorage` gespeichert wurde.
2. Die erste unterstützte Sprache aus der nach Präferenz sortierten
   Sprachliste des Browsers. Regionale Varianten wie `de-DE`, `de-AT`,
   `en-GB` und `da-DK` werden unterstützt.
3. Englisch, falls keine unterstützte Sprache gefunden wird.

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
- JavaScript ist direkt in die HTML-Datei eingebettet. Das begrenzt, wie
  restriktiv eine Content Security Policy sein kann. Weitere Hinweise stehen
  in `nginx.conf.DE.example`.
- Beim Betrieb auf einem Synology NAS kann ein DSM-Zugriffssteuerungsprofil
  den Zugriff auf bestimmte IP-Adressen oder lokale Netzwerke beschränken.

Das Dashboard sollte ohne vorgeschaltete, geeignete Zugriffskontrolle nicht
direkt aus dem Internet erreichbar sein.

## Roadmap

- **v1.1.005:** Vollständige dänische und englische Oberfläche und Dokumentation
- **v1.2.006:** Unterstützung für zwei, drei oder vier Pi-hole-Instanzen
- **v1.3.007:** Schlüsselbasierte Mehrsprachigkeit mit vollständiger dänischer, englischer und deutscher Oberfläche und Dokumentation
- **v1.4.xxx:** Docker-Image und vereinfachte Installation

Das Dashboard unterstützt zwei bis vier aktive Instanzen. Zusätzliche
Instanzen benötigen sowohl die passende Serveranzahl in `index.html` als
auch eine entsprechende Proxy-Weiterleitung in nginx.

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

Chart.js ist nicht enthalten und muss wie in der Einrichtungsanleitung
beschrieben separat heruntergeladen werden. Chart.js ist ein unabhängiges
Drittanbieterprojekt mit einer eigenen Lizenz.
