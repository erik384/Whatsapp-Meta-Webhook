# WhatsApp ↔ HubSpot Live-Sync (Bodenfix)

Node.js-Dienst, der die **WhatsApp Business Cloud API (Meta)** mit **HubSpot** verbindet:

| Was | Wie |
|---|---|
| Kunde schreibt per WhatsApp (Text, Sprachnachricht, Bild, Dokument) | Webhook trifft in Echtzeit ein → Nummer wird normalisiert und mit HubSpot abgeglichen → Nachricht landet als **WhatsApp-Kommunikation** in der Kontakt-Timeline. Sprachnachrichten werden transkribiert (optional) und als Datei angehängt. |
| Nummer ist in HubSpot unbekannt | Kontakt wird **nur als Lead** angelegt (Lifecycle `lead`, Lead-Status „Neuer Kontakt“) – wahlweise jede eingehende Anfrage (`inbound`), nur nach Claude-Prüfung „ist das eine Kundenanfrage?“ (`classify`) oder nie (`never`). |
| Erik schreibt in Claude „schick Herrn Müller: …“ | Claude ruft den **MCP-Server** dieses Dienstes auf → Nachricht geht über die Geschäftsnummer raus und wird ebenfalls am HubSpot-Kontakt protokolliert. |
| Nummern „immer abgleichen“ | Alle Kontakt-Telefonnummern (`phone`, `mobilephone`, `hs_whatsapp_phone_number`) werden fortlaufend in die Property **`whatsapp_e164`** normalisiert (+49…). Dadurch ist der Abgleich ein exakter Treffer, egal ob in HubSpot „0172-6748792“, „+49 172 …“ oder „0049172…“ steht. Läuft beim Start komplett und danach alle 15 Minuten inkrementell. |

## Architektur

```
WhatsApp (Kunde) ──Webhook──▶ POST /webhook ──▶ src/inbound.js
                                                 ├─ phone.js       Nummer → E.164
                                                 ├─ hubspot.js     Kontakt finden / Lead anlegen / Kommunikation + Datei
                                                 ├─ whatsapp.js    Medien laden, gelesen markieren
                                                 ├─ transcribe.js  Sprachnachricht → Text (OpenAI, optional)
                                                 └─ classify.js    Lead-Prüfung mit Claude (optional)

Claude (Handy/Desktop) ──MCP──▶ /mcp ──▶ src/mcp.js ──▶ src/outbound.js ──▶ WhatsApp senden + HubSpot loggen
curl / Skripte         ──────▶ POST /send ────────────┘
```

Zustand (verarbeitete Message-IDs, Konversationen, letzter Sync) liegt in `data/state.json`.

## Einrichtung

### 1. Meta / WhatsApp Business

1. Unter [developers.facebook.com](https://developers.facebook.com) eine App vom Typ **Business** anlegen und das Produkt **WhatsApp** hinzufügen.
2. Die Bodenfix-Geschäftsnummer registrieren (oder zunächst die Testnummer nutzen). **Wichtig:** Eine Nummer kann entweder in der WhatsApp-Business-App *oder* in der Cloud API laufen. Mit „Coexistence“ (seit 2025 verfügbar) lässt sich die bestehende Business-App-Nummer mit der Cloud API verbinden – dann bleiben Chats am Handy *und* laufen über diesen Dienst.
3. **System-User-Token** erstellen (Business-Einstellungen → System-Benutzer → Token generieren, unbegrenzt) mit den Berechtigungen `whatsapp_business_messaging` und `whatsapp_business_management` → `WHATSAPP_TOKEN`.
4. WhatsApp → API-Setup: **Phone number ID** kopieren → `WHATSAPP_PHONE_NUMBER_ID`.
5. App → Einstellungen → Allgemein: **App-Geheimcode** → `META_APP_SECRET` (prüft die Webhook-Signatur).
6. WhatsApp → Konfiguration → Webhook: Callback-URL `https://<deine-domain>/webhook`, Verify-Token = `VERIFY_TOKEN`. Webhook-Feld **`messages`** abonnieren.

### 2. HubSpot Private App

Einstellungen → Integrationen → Private Apps → App erstellen. Scopes:

- `crm.objects.contacts.read`, `crm.objects.contacts.write` (Kontakte + WhatsApp-Kommunikation)
- `crm.schemas.contacts.write` (legt die Property `whatsapp_e164` einmalig an)
- `files` (Sprachnachrichten/Bilder als private Datei an die Nachricht hängen)

Token → `HUBSPOT_TOKEN`. Optional `HUBSPOT_OWNER_ID` (Eriks Owner-ID 451143905), damit Nachrichten als von ihm geloggt erscheinen.

Empfehlung: in der Property **Leadherkunft** die Option „WhatsApp“ ergänzen und `LEADHERKUNFT_VALUE=WhatsApp` setzen. Fehlt die Option, legt der Dienst den Kontakt ohne Herkunft an und warnt im Log.

### 3. Dienst starten

```bash
cp .env.example .env     # Werte eintragen
npm install
npm test                 # 11 Tests: Nummern, Webhook-Parsing, Signatur, Abgleich, Zustand
npm start
```

Mit Docker:

```bash
docker build -t bodenfix-whatsapp .
docker run -d --env-file .env -p 3000:3000 -v $(pwd)/data:/app/data bodenfix-whatsapp
```

Der Dienst braucht eine öffentliche HTTPS-URL (Railway, Render, Fly.io, Hetzner + Caddy – alles geht; `data/` muss persistent sein). Lokal zum Testen: `ngrok http 3000`.

### 4. Claude anbinden (Senden vom Handy)

Der Dienst stellt einen **MCP-Server** unter `/mcp` bereit. Zwei Wege:

- **claude.ai / Claude-App (Handy):** Einstellungen → Connectors → „Benutzerdefinierten Connector hinzufügen“ → URL `https://<domain>/mcp/<MCP_PATH_SECRET>`. Der Pfad-Schlüssel ersetzt den Header, weil die App keine eigenen Header setzen kann. Den Schlüssel lang und zufällig wählen (`openssl rand -hex 24`).
- **Claude Desktop / Claude Code:** URL `https://<domain>/mcp` mit Header `Authorization: Bearer <API_KEY>`.

Danach reicht im Chat: *„Schreib der 0172 6748792 per WhatsApp, dass wir Donnerstag 9 Uhr kommen.“* Claude nutzt `whatsapp_send`, der Dienst sendet und loggt in HubSpot.

Werkzeuge:

| Tool | Zweck |
|---|---|
| `whatsapp_send` | Text oder Vorlage senden, automatisch in HubSpot protokolliert |
| `whatsapp_find_contact` | Nummer → HubSpot-Kontakt, Lead-Status, 24-h-Fenster |
| `whatsapp_recent_conversations` | Wer hat zuletzt geschrieben, mit Kontakt-Link |
| `whatsapp_history` | WhatsApp-Verlauf eines Kontakts aus HubSpot |
| `hubspot_sync_phone_index` | Telefon-Index manuell komplett abgleichen |

Ohne Claude: `POST /send` mit `{"to":"0172…","text":"…"}` und Header `x-api-key`, oder `npm run send -- "+49172…" "Text"`.

## Verhalten im Detail

**Abgleich eingehender Nummern.** Reihenfolge: exakter Treffer auf `whatsapp_e164` → `hs_whatsapp_phone_number` → Freitextsuche in mehreren Schreibweisen mit normalisiertem Nachvergleich. Ein Treffer ohne Index bekommt den Index sofort nachgetragen. Treffer werden lokal gemerkt, sodass Folgenachrichten HubSpot nur noch fürs Protokollieren brauchen.

**Lead-Regel (`LEAD_POLICY`).**
- `inbound` (Standard): Jede unbekannte Nummer, die *an* Bodenfix schreibt, wird als Lead angelegt – Name aus dem WhatsApp-Profil, `lifecyclestage=lead`, `hs_lead_status=NEW` („Neuer Kontakt“). Nummern, die Erik nur *anschreibt*, werden nie angelegt.
- `classify`: Zusätzlich prüft Claude (`claude-opus-5-5`, strukturierte Antwort) anhand der ersten Nachricht bzw. des Transkripts, ob es eine Kundenanfrage ist. Lieferanten, Bewerbungen, Spam und Privates werden nicht angelegt. Im Zweifel wird angelegt – ein verpasster Lead kostet mehr als ein überflüssiger Kontakt.
- `never`: nur synchronisieren, nichts anlegen.

Die Labels aus der WhatsApp-Business-App („Neuer Kunde“ usw.) stellt Meta über die API **nicht** bereit; die Lead-Regel ersetzt sie.

**Sprachnachrichten.** Audio wird von Meta geladen (URL läuft nach 5 Minuten ab, deshalb sofort), optional mit `gpt-4o-transcribe` auf Deutsch transkribiert und als private Datei in den HubSpot-Ordner `/whatsapp` geladen. In der Timeline steht dann z. B. `[WhatsApp Eingehend] Sprachnachricht – Transkript: …` mit Anhang. Ohne `OPENAI_API_KEY` bleibt die Datei, der Text entfällt.

**24-Stunden-Fenster.** Meta erlaubt Freitext nur, wenn der Kunde in den letzten 24 h geschrieben hat. Danach lehnt WhatsApp mit Code 131047 ab; der Dienst meldet das klar zurück und verweist auf Vorlagen (`template_name`). Vorlagen müssen im Meta Business Manager freigegeben sein. `whatsapp_find_contact` zeigt, ob das Fenster offen ist.

**Dubletten.** Meta liefert Webhooks bei langsamer Antwort mehrfach. Der Dienst antwortet sofort mit 200, verarbeitet asynchron und merkt sich verarbeitete Message-IDs.

**Sicherheit.** Webhook-Signatur (`X-Hub-Signature-256`) wird geprüft, sobald `META_APP_SECRET` gesetzt ist. `/send` und `/mcp` verlangen `API_KEY` (Bearer oder `x-api-key`) oder den Pfad-Schlüssel. Keine Tokens im Repo – alles über `.env`.

## Grenzen

- Nur Nachrichten, die über die Cloud API laufen, kommen an. Ein normales WhatsApp-Business-Handy ohne Coexistence liefert keine Webhooks.
- HubSpot-Suche deckt maximal 10 000 Kontakte pro Abfrage ab; der Index-Sync paginiert zu 100 und bricht nach 120 Seiten ab (reicht für den aktuellen Bestand von rund 1 700 Kontakten um ein Mehrfaches).
- Statusmeldungen (zugestellt/gelesen) werden lokal gespeichert, nicht nach HubSpot geschrieben.
- Zustand liegt in einer JSON-Datei; bei mehreren Instanzen eine gemeinsame Ablage oder eine Datenbank vorsehen.
