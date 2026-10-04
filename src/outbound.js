// Versand von WhatsApp-Nachrichten (aus Claude/MCP, /send oder CLI) mit
// automatischer Protokollierung am HubSpot-Kontakt.
import { config } from './config.js';
import { normalizePhone, toWaId } from './phone.js';
import { sendText, sendTemplate, isReengagementError } from './whatsapp.js';
import { findContactByPhone, logWhatsAppMessage, contactDisplayName, contactUrl } from './hubspot.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function createOutbound({ store, log = console }) {
  /** Liefert, ob die Nummer innerhalb des 24-h-Fensters liegt (nur bekannt, wenn der Kunde über diesen Webhook geschrieben hat). */
  function windowInfo(e164) {
    const conv = store.getConversation(e164);
    if (!conv?.lastInboundAt) return { known: false, open: null, lastInboundAt: null };
    const age = Date.now() - new Date(conv.lastInboundAt).getTime();
    return { known: true, open: age < WINDOW_MS, lastInboundAt: conv.lastInboundAt, remainingMinutes: Math.max(0, Math.round((WINDOW_MS - age) / 60000)) };
  }

  /**
   * @param {{to:string, text?:string, template?:{name:string, language?:string, components?:any[]}}} p
   */
  async function sendMessage({ to, text, template }) {
    const e164 = normalizePhone(to, config.lead.defaultCountryCode);
    if (!e164) throw new Error(`Nummer nicht erkennbar: ${to}`);
    if (!text && !template) throw new Error('Text oder Vorlage angeben.');

    const cached = store.getConversation(e164);
    let contact = null;
    try {
      contact = cached?.contactId ? { id: cached.contactId, properties: { firstname: cached.name } } : await findContactByPhone(e164);
    } catch (err) {
      log.warn(`[outbound] HubSpot-Suche fehlgeschlagen: ${err.message}`);
    }

    let sent;
    try {
      sent = template ? await sendTemplate(toWaId(e164), template) : await sendText(toWaId(e164), text);
    } catch (err) {
      if (isReengagementError(err)) {
        const w = windowInfo(e164);
        const hint = w.lastInboundAt ? `Letzte eingehende Nachricht: ${w.lastInboundAt}.` : 'Diese Nummer hat über diesen Anschluss noch nicht geschrieben.';
        throw new Error(`WhatsApp lehnt Freitext ab: 24-h-Fenster geschlossen. ${hint} Lösung: eine freigegebene Vorlage (template) senden; sobald der Kunde antwortet, geht Freitext wieder.`);
      }
      throw err;
    }

    const bodyForLog = text || `Vorlage "${template.name}" (${template.language || 'de'})`;
    store.rememberOutbound(sent.messageId, { to: e164, contactId: contact?.id || null, body: bodyForLog.slice(0, 200) });

    let communicationId = null;
    if (contact) {
      try {
        const logged = await logWhatsAppMessage({ contactId: contact.id, body: bodyForLog, direction: 'out', timestamp: Date.now(), waMessageId: sent.messageId });
        communicationId = logged.id;
      } catch (err) {
        log.warn(`[outbound] Protokollierung in HubSpot fehlgeschlagen: ${err.message}`);
      }
      store.updateConversation(e164, { contactId: contact.id, name: contactDisplayName(contact), lastOutboundAt: new Date().toISOString() });
    } else {
      store.updateConversation(e164, { lastOutboundAt: new Date().toISOString() });
    }

    return {
      to: e164,
      waMessageId: sent.messageId,
      contactId: contact?.id || null,
      contactName: contact ? contactDisplayName(contact) : null,
      contactUrl: contact ? contactUrl(contact.id) : null,
      communicationId,
      loggedInHubSpot: Boolean(communicationId),
      note: contact ? undefined : 'Kein HubSpot-Kontakt zu dieser Nummer; Nachricht wurde gesendet, aber nicht protokolliert. Kontakte werden nur für eingehende Lead-Anfragen angelegt.',
    };
  }

  return { sendMessage, windowInfo };
}
