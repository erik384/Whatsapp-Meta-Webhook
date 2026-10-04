// Lead-Prüfung mit Claude (nur bei LEAD_POLICY=classify).
// Entscheidet, ob eine unbekannte Nummer eine Kundenanfrage ist (-> Kontakt anlegen)
// oder Lieferant/Bewerbung/Spam/Privat (-> nicht anlegen).
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from './config.js';

const Verdict = z.object({
  is_lead: z.boolean(),
  category: z.enum(['kundenanfrage', 'bestandskunde', 'lieferant', 'bewerbung', 'spam', 'privat', 'unklar']),
  reason: z.string(),
});

const SYSTEM = `Du prüfst eingehende WhatsApp-Nachrichten an Bodenfix, einen Bodenleger-Betrieb (Parkett, Vinyl, Teppich, Schleifen, Ölen) aus Halstenbek bei Hamburg.
Entscheide, ob der Absender ein potenzieller Kunde ist (Lead): jemand, der eine Bodenarbeit anfragt, ein Angebot, einen Termin, eine Beratung oder Preise möchte, oder sich auf eine Anzeige/Empfehlung bezieht.
Kein Lead sind: Lieferanten und Vertriebler, Bewerbungen, Spam/Werbung, eindeutig private Nachrichten, Fehlzustellungen.
Bei kurzem Gruß ohne Inhalt ("Hallo", "Guten Tag") gilt: unklar, aber is_lead=true, denn ein echter Interessent beginnt oft so.
Antworte knapp und auf Deutsch.`;

let client;

/**
 * @returns {Promise<{is_lead:boolean, category:string, reason:string}>}
 * Fällt bei jedem Fehler auf is_lead=true zurück: ein verpasster Lead ist teurer als ein überflüssiger Kontakt.
 */
export async function classifyLead({ text, profileName, phone }) {
  if (!config.claude.apiKey) return { is_lead: true, category: 'unklar', reason: 'Kein ANTHROPIC_API_KEY, Standard: anlegen.' };
  client ??= new Anthropic({ apiKey: config.claude.apiKey });
  const content = `Absender: ${profileName || 'unbekannt'} (${phone})\nNachricht:\n${text || '(ohne Text, z. B. nur Medien)'}`;
  try {
    const response = await client.beta.messages.create({
      model: config.claude.model,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low', format: zodOutputFormat(Verdict) },
    });
    if (response.stop_reason === 'refusal') {
      return { is_lead: true, category: 'unklar', reason: 'Prüfung abgelehnt, Standard: anlegen.' };
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    const parsed = Verdict.safeParse(JSON.parse(textBlock?.text || '{}'));
    if (!parsed.success) return { is_lead: true, category: 'unklar', reason: 'Antwort nicht lesbar, Standard: anlegen.' };
    return parsed.data;
  } catch (err) {
    console.warn(`[classify] Fehler: ${err.message}`);
    return { is_lead: true, category: 'unklar', reason: `Fehler bei Prüfung (${err.message}), Standard: anlegen.` };
  }
}
