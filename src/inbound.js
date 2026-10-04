// Verarbeitung eingehender WhatsApp-Webhooks:
// Nummer normalisieren -> HubSpot-Kontakt finden (oder als Lead anlegen) ->
// Text/Transkript/Datei als WhatsApp-Kommunikation protokollieren.
import { config } from './config.js';
import { normalizePhone } from './phone.js';
import { parseWebhook, downloadMedia, markAsRead, extensionFor } from './whatsapp.js';
import { findContactByPhone, createLeadContact, logWhatsAppMessage, uploadFile, contactDisplayName } from './hubspot.js';
import { transcribeAudio, transcriptionAvailable } from './transcribe.js';
import { classifyLead } from './classify.js';

const TYPE_LABEL = { audio: 'Sprachnachricht', image: 'Bild', video: 'Video', document: 'Dokument', sticker: 'Sticker' };

export function createInboundProcessor({ store, log = console }) {
  async function resolveContact(e164, ev, messageText, { allowCreate = true } = {}) {
    const known = store.getConversation(e164);
    if (known?.contactId) {
      // Kontakt könnte in HubSpot gelöscht/zusammengeführt sein -> bei Fehler neu suchen
      return { contact: { id: known.contactId, properties: { firstname: known.name } }, created: false, source: 'cache' };
    }
    const found = await findContactByPhone(e164);
    if (found) return { contact: found, created: false, source: 'hubspot' };

    if (!allowCreate) return { contact: null, created: false, source: 'no-create' };
    if (config.lead.policy === 'never') return { contact: null, created: false, source: 'policy-never' };
    if (!ev.profileName && known?.profileName) ev.profileName = known.profileName; // Name aus dem App-Adressbuch (Coexistence)
    if (config.lead.policy === 'classify') {
      const verdict = await classifyLead({ text: messageText, profileName: ev.profileName, phone: e164 });
      log.info(`[inbound] Lead-Prüfung ${e164}: ${verdict.category} / is_lead=${verdict.is_lead} (${verdict.reason})`);
      if (!verdict.is_lead) return { contact: null, created: false, source: `classify:${verdict.category}` };
    }
    const { contact, created } = await createLeadContact({ e164, profileName: ev.profileName });
    return { contact, created, source: 'created' };
  }

  async function buildMessageBody(ev) {
    const attachments = [];
    let body = ev.text || '';
    let transcript = null;

    if (ev.media?.id) {
      const label = TYPE_LABEL[ev.type] || ev.type;
      let media = null;
      try {
        media = await downloadMedia(ev.media.id);
      } catch (err) {
        log.warn(`[inbound] Medium ${ev.media.id} nicht ladbar: ${err.message}`);
      }
      if (media && ev.type === 'audio') {
        try {
          transcript = await transcribeAudio({ buffer: media.buffer, mimeType: media.mimeType, filename: `voice.${extensionFor(media.mimeType)}` });
        } catch (err) {
          log.warn(`[inbound] Transkription fehlgeschlagen: ${err.message}`);
        }
      }
      if (media && config.hubspot.uploadMedia) {
        try {
          const stamp = new Date(ev.timestamp).toISOString().replace(/[:.]/g, '-');
          const filename = ev.media.filename || `whatsapp-${ev.type}-${stamp}.${extensionFor(media.mimeType)}`;
          const file = await uploadFile({ buffer: media.buffer, filename, mimeType: media.mimeType });
          attachments.push(file.id);
        } catch (err) {
          log.warn(`[inbound] Upload nach HubSpot fehlgeschlagen: ${err.message}`);
        }
      }
      const parts = [label];
      if (transcript) parts.push(`Transkript: ${transcript}`);
      else if (ev.type === 'audio') parts.push(transcriptionAvailable() ? 'Transkript nicht verfügbar' : 'keine Transkription konfiguriert');
      if (ev.caption) parts.push(ev.caption);
      if (!attachments.length && media === null) parts.push('(Datei konnte nicht übernommen werden)');
      body = parts.join(' – ');
    }
    return { body: body || `Nachricht vom Typ ${ev.type}`, attachments, transcript };
  }

  async function handleMessage(ev) {
    const isLive = ev.kind === 'message';
    const isEcho = ev.kind === 'echo';
    const isHistory = ev.kind === 'history';
    if (isEcho && !config.meta.logAppEchoes) return { skipped: 'echo-disabled' };
    if (isHistory && !config.meta.importHistory) return { skipped: 'history-disabled' };
    if (store.data.outbound[ev.messageId]) return { skipped: 'own-api-message' }; // über die API gesendet, schon geloggt
    if (!store.markProcessed(ev.messageId)) {
      log.info(`[inbound] ${ev.messageId} bereits verarbeitet, übersprungen.`);
      return { skipped: 'duplicate' };
    }
    const e164 = normalizePhone(ev.from, config.lead.defaultCountryCode);
    if (!e164) {
      log.warn(`[inbound] Nummer ${ev.from} nicht normalisierbar.`);
      return { skipped: 'bad-number' };
    }
    const direction = ev.direction === 'out' ? 'out' : 'in';

    // Verlaufsimport: keine Medien nachladen (IDs sind meist abgelaufen), nur Text/Typ übernehmen
    const { body, attachments, transcript } = isHistory ? { body: historyBody(ev), attachments: [], transcript: null } : await buildMessageBody(ev);
    const classifyText = transcript || ev.text || ev.caption || '';
    // Neue Lead-Kontakte entstehen nur aus live eingehenden Nachrichten, nie aus Echo/Verlauf
    const { contact, created, source } = await resolveContact(e164, ev, classifyText, { allowCreate: isLive });

    const patch = {
      contactId: contact?.id || null,
      name: contact ? contactDisplayName(contact) : ev.profileName || undefined,
      profileName: ev.profileName || undefined,
      lastResolution: source,
    };
    const stamp = new Date(ev.timestamp).toISOString();
    const prev = store.getConversation(e164) || {};
    if (direction === 'in' && (!prev.lastInboundAt || prev.lastInboundAt < stamp)) { patch.lastInboundAt = stamp; patch.lastMessage = body.slice(0, 200); }
    if (direction === 'out' && (!prev.lastOutboundAt || prev.lastOutboundAt < stamp)) patch.lastOutboundAt = stamp;
    store.updateConversation(e164, patch);

    if (isLive && config.meta.markAsRead) markAsRead(ev.messageId).catch((err) => log.warn(`[inbound] markAsRead: ${err.message}`));

    if (!contact) {
      if (isLive) log.info(`[inbound] ${e164} (${ev.profileName || 'ohne Name'}) nicht in HubSpot, kein Kontakt angelegt (${source}). Nachricht: ${body.slice(0, 80)}`);
      return { e164, contactId: null, source, kind: ev.kind };
    }

    const logIt = (contactId) => logWhatsAppMessage({ contactId, body, direction, timestamp: ev.timestamp, attachmentIds: attachments, waMessageId: ev.messageId });
    let logged;
    try {
      logged = await logIt(contact.id);
    } catch (err) {
      if (err.status === 404 || err.status === 400) {
        // Cache zeigte auf einen nicht mehr existierenden Kontakt -> neu auflösen
        store.updateConversation(e164, { contactId: null });
        const again = await findContactByPhone(e164);
        if (!again) throw err;
        store.updateConversation(e164, { contactId: again.id, name: contactDisplayName(again) });
        logged = await logIt(again.id);
        contact.id = again.id;
      } else throw err;
    }
    const label = isHistory ? 'Verlauf' : isEcho ? 'App-Echo' : created ? 'neu als Lead angelegt' : source;
    log.info(`[inbound] ${e164} ${direction === 'out' ? '<-' : '->'} Kontakt ${contact.id} (${label}), Kommunikation ${logged.id}`);
    return { e164, contactId: contact.id, created, communicationId: logged.id, kind: ev.kind, direction };
  }

  function historyBody(ev) {
    if (ev.text) return ev.text;
    const label = TYPE_LABEL[ev.type] || ev.type;
    return [label, ev.caption].filter(Boolean).join(' – ') + ' (aus App-Verlauf, Datei nicht übernommen)';
  }

  /** Coexistence: Adressbuch der Business-App -> Namen merken, keine HubSpot-Kontakte anlegen. */
  function handleContactSync(ev) {
    const e164 = normalizePhone(ev.phone, config.lead.defaultCountryCode);
    if (!e164) return { skipped: 'bad-number' };
    if (ev.action === 'remove') return { e164, action: 'remove' };
    store.updateConversation(e164, { profileName: ev.fullName || undefined, inAppAddressBook: true });
    return { e164, action: ev.action, name: ev.fullName };
  }

  function handleStatus(ev) {
    const entry = store.updateOutboundStatus(ev.messageId, ev.status, new Date(ev.timestamp).toISOString());
    if (ev.status === 'failed') log.warn(`[status] Nachricht ${ev.messageId} an ${ev.recipient} fehlgeschlagen: ${ev.errors.map((e) => `${e.code} ${e.title}`).join(', ')}`);
    return { messageId: ev.messageId, status: ev.status, known: Boolean(entry) };
  }

  /** Verarbeitet einen kompletten Webhook-Body. Fehler einzelner Nachrichten brechen die anderen nicht ab. */
  async function processWebhook(body) {
    const results = [];
    for (const ev of parseWebhook(body)) {
      try {
        if (ev.kind === 'message' || ev.kind === 'echo' || ev.kind === 'history') results.push(await handleMessage(ev));
        else if (ev.kind === 'status') results.push(handleStatus(ev));
        else if (ev.kind === 'contact') results.push(handleContactSync(ev));
      } catch (err) {
        log.error(`[inbound] Fehler bei ${ev.kind} ${ev.messageId}: ${err.message}`);
        results.push({ error: err.message, messageId: ev.messageId });
      }
    }
    return results;
  }

  return { processWebhook, handleMessage, handleStatus, handleContactSync };
}
