// WhatsApp Cloud API: Webhook-Signatur, Payload-Parsing, Senden, Medien.
import crypto from 'node:crypto';
import { config } from './config.js';

const graph = () => `https://graph.facebook.com/${config.meta.graphVersion}`;

/** Prüft X-Hub-Signature-256 gegen den Roh-Body. Ohne META_APP_SECRET wird nicht geprüft. */
export function verifySignature(rawBody, signatureHeader, appSecret = config.meta.appSecret) {
  if (!appSecret) return true;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = signatureHeader.slice('sha256='.length);
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
}

/**
 * Zerlegt einen Webhook-Body in flache Ereignisse.
 * { kind: 'message', messageId, from, profileName, timestamp, type, text, caption, media:{id,mimeType,voice,filename}, raw }
 * { kind: 'status',  messageId, status, recipient, timestamp }
 */
export function parseWebhook(body) {
  const events = [];
  if (!body || body.object !== 'whatsapp_business_account') return events;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (change.field !== 'messages') continue;
      const phoneNumberId = value.metadata?.phone_number_id;
      const names = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        const ev = {
          kind: 'message',
          phoneNumberId,
          messageId: m.id,
          from: m.from,
          profileName: names.get(m.from) || '',
          timestamp: Number(m.timestamp) * 1000,
          type: m.type,
          text: '',
          caption: '',
          media: null,
          raw: m,
        };
        switch (m.type) {
          case 'text':
            ev.text = m.text?.body || '';
            break;
          case 'button':
            ev.text = m.button?.text || '';
            break;
          case 'interactive':
            ev.text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
            break;
          case 'audio':
          case 'image':
          case 'video':
          case 'document':
          case 'sticker': {
            const media = m[m.type] || {};
            ev.media = { id: media.id, mimeType: media.mime_type, voice: Boolean(media.voice), filename: media.filename, sha256: media.sha256 };
            ev.caption = media.caption || '';
            break;
          }
          case 'location':
            ev.text = `Standort: ${m.location?.name || ''} ${m.location?.address || ''} (${m.location?.latitude}, ${m.location?.longitude})`.trim();
            break;
          case 'contacts':
            ev.text = 'Kontakt geteilt: ' + (m.contacts || []).map((c) => `${c.name?.formatted_name || ''} ${(c.phones || []).map((p) => p.phone).join(', ')}`.trim()).join('; ');
            break;
          case 'reaction':
            ev.text = `Reaktion ${m.reaction?.emoji || ''} auf Nachricht ${m.reaction?.message_id || ''}`;
            break;
          default:
            ev.text = m.errors?.length ? `Nicht unterstützte Nachricht (${m.errors.map((e) => e.title).join(', ')})` : `Nachricht vom Typ ${m.type}`;
        }
        events.push(ev);
      }
      for (const s of value.statuses || []) {
        events.push({ kind: 'status', phoneNumberId, messageId: s.id, status: s.status, recipient: s.recipient_id, timestamp: Number(s.timestamp) * 1000, errors: s.errors || [] });
      }
    }
  }
  return events;
}

async function graphRequest(path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${graph()}/${path}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.meta.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const e = json?.error || {};
    const err = new Error(`WhatsApp ${method} ${path} -> ${res.status}: ${e.message || text.slice(0, 300)}`);
    err.status = res.status;
    err.code = e.code;
    err.subcode = e.error_subcode;
    err.details = e.error_data?.details;
    throw err;
  }
  return json;
}

/** Freitext senden (nur innerhalb des 24-h-Kundenservice-Fensters erlaubt). */
export async function sendText(toWaId, body) {
  const r = await graphRequest(`${config.meta.phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId, type: 'text', text: { preview_url: false, body } },
  });
  return { messageId: r.messages?.[0]?.id, waId: r.contacts?.[0]?.wa_id };
}

/** Vorlage senden (nötig, wenn der Kunde seit >24 h nicht geschrieben hat). */
export async function sendTemplate(toWaId, { name, language = 'de', components = [] }) {
  const r = await graphRequest(`${config.meta.phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to: toWaId, type: 'template', template: { name, language: { code: language }, components } },
  });
  return { messageId: r.messages?.[0]?.id, waId: r.contacts?.[0]?.wa_id };
}

export async function markAsRead(messageId) {
  return graphRequest(`${config.meta.phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
  });
}

/** Lädt ein Medium (Sprachnachricht, Bild, Dokument) herunter. Media-URLs laufen nach 5 Minuten ab. */
export async function downloadMedia(mediaId) {
  const meta = await graphRequest(mediaId, { query: { phone_number_id: config.meta.phoneNumberId } });
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${config.meta.token}`, 'User-Agent': 'curl/8' } });
  if (!res.ok) throw new Error(`Medien-Download fehlgeschlagen (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: meta.mime_type || res.headers.get('content-type') || 'application/octet-stream', size: meta.file_size, sha256: meta.sha256 };
}

/** Dateiendung aus MIME-Typ für Uploads. */
export function extensionFor(mimeType = '') {
  const base = mimeType.split(';')[0].trim();
  const map = {
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4',
    'application/pdf': 'pdf', 'text/plain': 'txt',
  };
  return map[base] || base.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
}

/** Fehlercode 131047 = Re-Engagement: Kunde hat seit >24 h nicht geschrieben. */
export function isReengagementError(err) {
  return err?.code === 131047 || /re-?engagement|24 hours|131047/i.test(err?.message || '');
}
