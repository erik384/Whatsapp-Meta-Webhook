// WhatsApp Cloud API <-> HubSpot Live-Sync für Bodenfix.
// Routen:
//   GET  /webhook (und /)      Meta-Verifizierung
//   POST /webhook (und /)      eingehende Nachrichten/Status (sofort 200, Verarbeitung asynchron)
//   POST /send                 Nachricht senden  { to, text | template }   (API_KEY)
//   ALL  /mcp, /mcp/<secret>   MCP-Server für Claude                        (API_KEY oder MCP_PATH_SECRET)
//   GET  /health
import express from 'express';
import { config, missingConfig } from './src/config.js';
import { Store } from './src/store.js';
import { verifySignature } from './src/whatsapp.js';
import { ensurePhoneIndexProperty, syncPhoneIndex } from './src/hubspot.js';
import { createInboundProcessor } from './src/inbound.js';
import { createOutbound } from './src/outbound.js';
import { mcpHandler } from './src/mcp.js';

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

const store = new Store(config.stateFile);
const inbound = createInboundProcessor({ store, log });
const outbound = createOutbound({ store, log });

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ----------------------------------------------------------------- Webhook
function verifyRoute(req, res) {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
  if (mode === 'subscribe' && token && token === config.verifyToken) {
    log.info('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }
  return res.status(403).end();
}

function webhookRoute(req, res) {
  if (!verifySignature(req.rawBody || Buffer.alloc(0), req.get('x-hub-signature-256'))) {
    log.warn('[webhook] Ungültige Signatur, verworfen.');
    return res.status(401).end();
  }
  res.status(200).end(); // Meta erwartet schnelle Antwort, sonst Wiederholungen
  inbound.processWebhook(req.body).catch((err) => log.error('[webhook] Verarbeitung fehlgeschlagen:', err));
}

app.get(['/', '/webhook'], verifyRoute);
app.post(['/', '/webhook'], webhookRoute);

// -------------------------------------------------------------------- Auth
function presentedKey(req) {
  const auth = req.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.get('x-api-key') || '';
}

function requireApiKey(req, res, next) {
  if (config.apiKey && presentedKey(req) === config.apiKey) return next();
  if (config.mcpPathSecret && req.params.secret === config.mcpPathSecret) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// -------------------------------------------------------------------- Send
app.post('/send', requireApiKey, async (req, res) => {
  try {
    const { to, text, template } = req.body || {};
    const result = await outbound.sendMessage({ to, text, template });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --------------------------------------------------------------------- MCP
app.all('/mcp', requireApiKey, mcpHandler({ outbound, store }));
app.all('/mcp/:secret', requireApiKey, mcpHandler({ outbound, store }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, lastSync: store.lastSync, conversations: Object.keys(store.data.conversations).length, leadPolicy: config.lead.policy });
});

// ------------------------------------------------------------------- Start
async function runSync(full = false) {
  const started = new Date().toISOString();
  try {
    const stats = await syncPhoneIndex({ since: full ? null : store.lastSync, log });
    store.lastSync = started;
    log.info(`[sync] Telefon-Index: ${stats.scanned} Kontakte geprüft, ${stats.updated} aktualisiert.`);
  } catch (err) {
    log.error(`[sync] fehlgeschlagen: ${err.message}`);
  }
}

const missing = missingConfig();
if (missing.length) log.warn(`[config] Fehlende Einstellungen: ${missing.join(', ')} – siehe .env.example`);

app.listen(config.port, async () => {
  log.info(`Listening on port ${config.port} (Lead-Regel: ${config.lead.policy})`);
  if (!config.hubspot.token) return;
  try {
    const prop = await ensurePhoneIndexProperty();
    log.info(`[hubspot] Index-Property ${prop.name} ${prop.created ? 'angelegt' : 'vorhanden'}.`);
  } catch (err) {
    log.error(`[hubspot] Index-Property konnte nicht geprüft werden: ${err.message}`);
  }
  await runSync(!store.lastSync);
  if (config.hubspot.syncIntervalMinutes > 0) {
    setInterval(() => runSync(false), config.hubspot.syncIntervalMinutes * 60 * 1000).unref();
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
