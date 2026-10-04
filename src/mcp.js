// MCP-Server (Streamable HTTP, zustandslos): macht WhatsApp-Versand und
// HubSpot-Abgleich als Werkzeuge für Claude (claude.ai-Connector, Claude Desktop, Claude Code) verfügbar.
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { config } from './config.js';
import { normalizePhone } from './phone.js';
import { findContactByPhone, listWhatsAppHistory, contactDisplayName, contactUrl, syncPhoneIndex } from './hubspot.js';

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

export function buildMcpServer({ outbound, store }) {
  const server = new McpServer({ name: 'bodenfix-whatsapp', version: '1.0.0' });

  server.registerTool(
    'whatsapp_send',
    {
      title: 'WhatsApp-Nachricht senden',
      description:
        'Sendet eine WhatsApp-Nachricht über die Bodenfix-Geschäftsnummer und protokolliert sie am HubSpot-Kontakt. ' +
        'Freitext geht nur, wenn der Kunde in den letzten 24 Stunden geschrieben hat; sonst template_name angeben.',
      inputSchema: z.object({
        to: z.string().describe('Empfängernummer, beliebiges Format (+49 170 ..., 0170..., 49170...)'),
        text: z.string().optional().describe('Nachrichtentext (Freitext, 24-h-Fenster)'),
        template_name: z.string().optional().describe('Name einer freigegebenen WhatsApp-Vorlage (für Erstkontakt/Re-Engagement)'),
        template_language: z.string().optional().describe('Sprachcode der Vorlage, Standard de'),
        template_parameters: z.array(z.string()).optional().describe('Textparameter {{1}}, {{2}} ... für den Vorlagen-Body'),
      }),
    },
    async ({ to, text: body, template_name, template_language, template_parameters }) => {
      const template = template_name
        ? {
            name: template_name,
            language: template_language || 'de',
            components: template_parameters?.length ? [{ type: 'body', parameters: template_parameters.map((t) => ({ type: 'text', text: t })) }] : [],
          }
        : undefined;
      try {
        const result = await outbound.sendMessage({ to, text: body, template });
        return text(result);
      } catch (err) {
        return { ...text(`Senden fehlgeschlagen: ${err.message}`), isError: true };
      }
    }
  );

  server.registerTool(
    'whatsapp_find_contact',
    {
      title: 'HubSpot-Kontakt zur Nummer finden',
      description: 'Gleicht eine Telefonnummer mit HubSpot ab und liefert den Kontakt (Name, Lead-Status, Link) sowie den Stand des 24-h-Fensters.',
      inputSchema: z.object({ phone: z.string().describe('Telefonnummer in beliebigem Format') }),
    },
    async ({ phone }) => {
      const e164 = normalizePhone(phone, config.lead.defaultCountryCode);
      if (!e164) return { ...text(`Nummer nicht erkennbar: ${phone}`), isError: true };
      const contact = await findContactByPhone(e164);
      return text({
        phone: e164,
        contact: contact
          ? { id: contact.id, name: contactDisplayName(contact), leadStatus: contact.properties.hs_lead_status, lifecycleStage: contact.properties.lifecyclestage, email: contact.properties.email, url: contactUrl(contact.id) }
          : null,
        window: outbound.windowInfo(e164),
      });
    }
  );

  server.registerTool(
    'whatsapp_recent_conversations',
    {
      title: 'Letzte WhatsApp-Konversationen',
      description: 'Listet die zuletzt aktiven WhatsApp-Nummern mit HubSpot-Kontakt, letzter Nachricht und Stand des 24-h-Fensters.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    },
    async ({ limit }) => {
      const rows = store.recentConversations(limit || 20).map((c) => ({
        phone: c.phone,
        name: c.name || c.profileName || null,
        contactId: c.contactId,
        contactUrl: c.contactId ? contactUrl(c.contactId) : null,
        lastInboundAt: c.lastInboundAt || null,
        lastOutboundAt: c.lastOutboundAt || null,
        lastMessage: c.lastMessage || null,
        window: outbound.windowInfo(c.phone),
        resolution: c.lastResolution,
      }));
      return text(rows);
    }
  );

  server.registerTool(
    'whatsapp_history',
    {
      title: 'WhatsApp-Verlauf aus HubSpot',
      description: 'Liefert die in HubSpot protokollierten WhatsApp-Nachrichten (ein- und ausgehend) zu einer Nummer.',
      inputSchema: z.object({ phone: z.string(), limit: z.number().int().min(1).max(100).optional() }),
    },
    async ({ phone, limit }) => {
      const e164 = normalizePhone(phone, config.lead.defaultCountryCode);
      if (!e164) return { ...text(`Nummer nicht erkennbar: ${phone}`), isError: true };
      const contact = await findContactByPhone(e164);
      if (!contact) return text({ phone: e164, contact: null, messages: [] });
      const messages = await listWhatsAppHistory(contact.id, limit || 20);
      return text({ phone: e164, contact: { id: contact.id, name: contactDisplayName(contact), url: contactUrl(contact.id) }, messages });
    }
  );

  server.registerTool(
    'hubspot_sync_phone_index',
    {
      title: 'Telefon-Index abgleichen',
      description: 'Normalisiert die Telefonnummern aller HubSpot-Kontakte in die WhatsApp-Index-Property (läuft sonst automatisch im Intervall).',
      inputSchema: z.object({ full: z.boolean().optional().describe('true = alle Kontakte, sonst nur seit letztem Lauf geänderte') }),
    },
    async ({ full }) => {
      const since = full ? null : store.lastSync;
      const started = new Date().toISOString();
      const stats = await syncPhoneIndex({ since });
      store.lastSync = started;
      return text({ since, ...stats });
    }
  );

  return server;
}

/** Express-Handler: pro Anfrage eigener Server + Transport (zustandslos). */
export function mcpHandler(deps) {
  return async (req, res) => {
    const server = buildMcpServer(deps);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
