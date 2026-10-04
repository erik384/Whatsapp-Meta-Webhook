// Kleiner persistenter Zustand als JSON-Datei:
// - bereits verarbeitete WhatsApp-Message-IDs (Meta liefert Webhooks mehrfach)
// - Konversationen je Nummer (HubSpot-Kontakt, letzte eingehende Nachricht, Name)
// - Zeitpunkt des letzten Telefon-Index-Abgleichs
import fs from 'node:fs';
import path from 'node:path';

const MAX_PROCESSED = 5000;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { processed: {}, conversations: {}, lastSync: null, outbound: {} };
    this._timer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = { ...this.data, ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] Zustand nicht lesbar (${err.message}), starte leer.`);
    }
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[store] Zustand nicht speicherbar: ${err.message}`);
    }
  }

  /** true, wenn die Nachricht neu ist (und merkt sie sich). */
  markProcessed(messageId) {
    if (!messageId) return true;
    if (this.data.processed[messageId]) return false;
    this.data.processed[messageId] = Date.now();
    const keys = Object.keys(this.data.processed);
    if (keys.length > MAX_PROCESSED) {
      keys
        .sort((a, b) => this.data.processed[a] - this.data.processed[b])
        .slice(0, keys.length - MAX_PROCESSED)
        .forEach((k) => delete this.data.processed[k]);
    }
    this.save();
    return true;
  }

  getConversation(e164) {
    return this.data.conversations[e164] || null;
  }

  updateConversation(e164, patch) {
    const current = this.data.conversations[e164] || {};
    this.data.conversations[e164] = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.save();
    return this.data.conversations[e164];
  }

  recentConversations(limit = 20) {
    return Object.entries(this.data.conversations)
      .map(([phone, c]) => ({ phone, ...c }))
      .sort((a, b) => String(b.lastInboundAt || b.updatedAt || '').localeCompare(String(a.lastInboundAt || a.updatedAt || '')))
      .slice(0, limit);
  }

  rememberOutbound(waMessageId, info) {
    this.data.outbound[waMessageId] = { ...info, sentAt: new Date().toISOString() };
    const keys = Object.keys(this.data.outbound);
    if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach((k) => delete this.data.outbound[k]);
    this.save();
  }

  updateOutboundStatus(waMessageId, status, timestamp) {
    const entry = this.data.outbound[waMessageId];
    if (!entry) return null;
    entry.status = status;
    entry.statusAt = timestamp;
    this.save();
    return entry;
  }

  get lastSync() {
    return this.data.lastSync;
  }

  set lastSync(value) {
    this.data.lastSync = value;
    this.save();
  }
}
