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
  async function resolveContact(e164, ev, messageText) {
    const known = store.getConversation(e164);
    if (known?.contactId) {
      // Kontakt könnte in HubSpot gelöscht/zusammengeführt sein -> bei Fehler neu suchen
      return { contact: { id: known.contactId, properties: { firstname: known.name } }, created: false, source: 'cache' };
    }
    const found = await findContactByPhone(e164);
    if (found) return { contact: found, created: false, source: 'hubspot' };

    if (config.lead.policy === 'never') return { contact: null, created: false, source: 'policy-never' };
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
    if (!store.markProcessed(ev.messageId)) {
      log.info(`[inbound] ${ev.messageId} bereits verarbeitet, übersprungen.`);
      return { skipped: 'duplicate' };
    }
    const e164 = normalizePhone(ev.from, config.lead.defaultCountryCode);
    if (!e164) {
      log.warn(`[inbound] Absender ${ev.from} nicht normalisierbar.`);
      return { skipped: 'bad-number' };
    }

    const { body, attachments, transcript } = await buildMessageBody(ev);
    const classifyText = transcript || ev.text || ev.caption || '';
    const { contact, created, source } = await resolveContact(e164, ev, classifyText);

    store.updateConversation(e164, {
      contactId: contact?.id || null,
      name: contact ? contactDisplayName(contact) : ev.profileName || null,
      profileName: ev.profileName || undefined,
      lastInboundAt: new Date(ev.timestamp).toISOString(),
      lastMessage: body.slice(0, 200),
      lastResolution: source,
    });

    if (config.meta.markAsRead) markAsRead(ev.messageId).catch((err) => log.warn(`[inbound] markAsRead: ${err.message}`));

    if (!contact) {
      log.info(`[inbound] ${e164} (${ev.profileName || 'ohne Name'}) nicht in HubSpot, kein Kontakt angelegt (${source}). Nachricht: ${body.slice(0, 80)}`);
      return { e164, contactId: null, source };
    }

    let logged;
    try {
      logged = await logWhatsAppMessage({ contactId: contact.id, body, direction: 'in', timestamp: ev.timestamp, attachmentIds: attachments, waMessageId: ev.messageId });
    } catch (err) {
      if (err.status === 404 || err.status === 400) {
        // Cache zeigte auf einen nicht mehr existierenden Kontakt -> neu auflösen
        store.updateConversation(e164, { contactId: null });
        const again = await findContactByPhone(e164);
        if (!again) throw err;
        store.updateConversation(e164, { contactId: again.id, name: contactDisplayName(again) });
        logged = await logWhatsAppMessage({ contactId: again.id, body, direction: 'in', timestamp: ev.timestamp, attachmentIds: attachments, waMessageId: ev.messageId });
        contact.id = again.id;
      } else throw err;
    }
    log.info(`[inbound] ${e164} -> Kontakt ${contact.id} (${created ? 'neu als Lead angelegt' : source}), Kommunikation ${logged.id}`);
    return { e164, contactId: contact.id, created, communicationId: logged.id };
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
        if (ev.kind === 'message') results.push(await handleMessage(ev));
        else if (ev.kind === 'status') results.push(handleStatus(ev));
      } catch (err) {
        log.error(`[inbound] Fehler bei ${ev.kind} ${ev.messageId}: ${err.message}`);
        results.push({ error: err.message, messageId: ev.messageId });
      }
    }
    return results;
  }

  return { processWebhook, handleMessage, handleStatus };
}
