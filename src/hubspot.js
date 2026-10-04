// HubSpot-Client: Kontakte finden/anlegen, WhatsApp-Nachrichten als
// Kommunikation protokollieren, Dateien hochladen, Telefon-Index pflegen.
import { config } from './config.js';
import { normalizePhone, toNational, splitName } from './phone.js';

const BASE = 'https://api.hubapi.com';
const COMMUNICATION_TO_CONTACT = 81; // HubSpot-definierte Association: communication -> contact

const CONTACT_PROPS = ['firstname', 'lastname', 'phone', 'mobilephone', 'hs_whatsapp_phone_number', 'hs_lead_status', 'lifecyclestage', 'email', 'company'];

async function hs(path, { method = 'GET', body, query, headers = {}, raw = false } = {}, attempt = 1) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  const init = {
    method,
    headers: { Authorization: `Bearer ${config.hubspot.token}`, ...headers },
  };
  if (body !== undefined) {
    if (body instanceof FormData) init.body = body;
    else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, init);
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = Number(res.headers.get('retry-after') || 0) * 1000 || 500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
    return hs(path, { method, body, query, headers, raw }, attempt + 1);
  }
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HubSpot ${method} ${path} -> ${res.status}: ${json?.message || text.slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------- Properties

/** Legt die Index-Property (E.164-Nummer) an, falls sie fehlt. Idempotent. */
export async function ensurePhoneIndexProperty() {
  const name = config.hubspot.phoneIndexProperty;
  try {
    await hs(`/crm/v3/properties/contacts/${name}`);
    return { created: false, name };
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await hs('/crm/v3/properties/contacts', {
    method: 'POST',
    body: {
      name,
      label: 'WhatsApp-Nummer (E.164)',
      description: 'Automatisch aus Telefon/Mobil normalisiert (+49...). Dient dem Abgleich eingehender WhatsApp-Nachrichten. Nicht manuell pflegen.',
      groupName: 'contactinformation',
      type: 'string',
      fieldType: 'text',
      hasUniqueValue: false,
      formField: false,
    },
  });
  return { created: true, name };
}

/** Fügt einer Enumerations-Property eine Option hinzu (reine Funktion, für Tests). */
export function mergeEnumOption(options, value, label = value) {
  const existing = options || [];
  if (existing.some((o) => o.value === value)) return { options: existing, added: false };
  return {
    options: [...existing, { label, value, displayOrder: existing.length, hidden: false }],
    added: true,
  };
}

/** Stellt sicher, dass die Option (z. B. "WhatsApp") in Leadherkunft existiert. Idempotent. */
export async function ensureLeadherkunftOption(value = config.lead.herkunft) {
  if (!value) return { ensured: false };
  const prop = await hs('/crm/v3/properties/contacts/leadherkunft');
  const { options, added } = mergeEnumOption(prop.options, value);
  if (!added) return { ensured: true, added: false };
  await hs('/crm/v3/properties/contacts/leadherkunft', {
    method: 'PATCH',
    body: { options: options.map(({ label, value: v, displayOrder, hidden }) => ({ label, value: v, displayOrder, hidden: Boolean(hidden) })) },
  });
  return { ensured: true, added: true };
}

// ------------------------------------------------------------------ Kontakte

function contactFromResult(r) {
  return { id: String(r.id), properties: r.properties || {} };
}

export function contactDisplayName(contact) {
  const p = contact?.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
  return name || p.email || p.phone || p.mobilephone || `Kontakt ${contact?.id}`;
}

export function contactUrl(contactId) {
  return `https://app-eu1.hubspot.com/contacts/${config.hubspot.portalId}/record/0-1/${contactId}`;
}

/** Bestimmt, welche Kandidaten wirklich zur Nummer passen (normalisierter Vergleich). */
export function pickMatchingContact(candidates, e164, cc = config.lead.defaultCountryCode) {
  const idx = config.hubspot.phoneIndexProperty;
  const matches = candidates.filter((c) => {
    const p = c.properties || {};
    return [p[idx], p.hs_whatsapp_phone_number, p.mobilephone, p.phone].some((v) => v && normalizePhone(v, cc) === e164);
  });
  if (matches.length === 0) return null;
  // Bei mehreren Treffern: zuerst der mit gesetztem Index, dann der zuletzt geänderte
  matches.sort((a, b) => {
    const ai = a.properties?.[idx] ? 1 : 0;
    const bi = b.properties?.[idx] ? 1 : 0;
    if (ai !== bi) return bi - ai;
    return String(b.properties?.lastmodifieddate || '').localeCompare(String(a.properties?.lastmodifieddate || ''));
  });
  return matches[0];
}

async function searchContacts(body) {
  const res = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body });
  return (res.results || []).map(contactFromResult);
}

/**
 * Sucht den HubSpot-Kontakt zu einer E.164-Nummer.
 * Reihenfolge: Index-Property -> hs_whatsapp_phone_number -> Freitextsuche über
 * phone/mobilephone in mehreren Schreibweisen, immer mit normalisiertem Nachvergleich.
 */
export async function findContactByPhone(e164) {
  const idx = config.hubspot.phoneIndexProperty;
  const props = [...CONTACT_PROPS, idx, 'lastmodifieddate'];
  const cc = config.lead.defaultCountryCode;

  const exact = await searchContacts({
    filterGroups: [
      { filters: [{ propertyName: idx, operator: 'EQ', value: e164 }] },
      { filters: [{ propertyName: 'hs_whatsapp_phone_number', operator: 'EQ', value: e164 }] },
    ],
    properties: props,
    limit: 10,
  });
  const hit = pickMatchingContact(exact, e164, cc);
  if (hit) return hit;

  const digits = e164.replace(/^\+/, '');
  const queries = new Set([e164, digits, toNational(e164, cc), digits.slice(-9)].filter(Boolean));
  const candidates = new Map();
  for (const q of queries) {
    try {
      const found = await searchContacts({ query: q, properties: props, limit: 20 });
      found.forEach((c) => candidates.set(c.id, c));
    } catch (err) {
      console.warn(`[hubspot] Suche "${q}" fehlgeschlagen: ${err.message}`);
    }
  }
  const match = pickMatchingContact([...candidates.values()], e164, cc);
  if (match && !match.properties[idx]) {
    // Index nachziehen, damit der nächste Abgleich ein exakter Treffer ist
    await updateContact(match.id, { [idx]: e164 }).catch((err) => console.warn(`[hubspot] Index-Update fehlgeschlagen: ${err.message}`));
    match.properties[idx] = e164;
  }
  return match;
}

export async function getContact(id) {
  const r = await hs(`/crm/v3/objects/contacts/${id}`, { query: { properties: [...CONTACT_PROPS, config.hubspot.phoneIndexProperty].join(',') } });
  return contactFromResult(r);
}

export async function updateContact(id, properties) {
  return hs(`/crm/v3/objects/contacts/${id}`, { method: 'PATCH', body: { properties } });
}

/** Legt einen neuen Lead-Kontakt für eine WhatsApp-Nummer an. */
export async function createLeadContact({ e164, profileName }) {
  const { firstname, lastname } = splitName(profileName);
  const properties = {
    phone: e164,
    mobilephone: e164,
    hs_whatsapp_phone_number: e164,
    [config.hubspot.phoneIndexProperty]: e164,
    lifecyclestage: config.lead.lifecycleStage,
    hs_lead_status: config.lead.status,
  };
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;
  if (!firstname && !lastname) properties.firstname = `WhatsApp ${e164}`;
  if (config.lead.herkunft) properties.leadherkunft = config.lead.herkunft;
  if (config.hubspot.ownerId) properties.hubspot_owner_id = config.hubspot.ownerId;

  try {
    const r = await hs('/crm/v3/objects/contacts', { method: 'POST', body: { properties } });
    return { contact: contactFromResult(r), created: true };
  } catch (err) {
    // 409: HubSpot kennt die Nummer/E-Mail schon -> vorhandenen Kontakt nehmen
    const existing = /Existing ID:\s*(\d+)/i.exec(err.message || '');
    if (err.status === 409 && existing) {
      const contact = await getContact(existing[1]);
      return { contact, created: false };
    }
    if (err.status === 400 && config.lead.herkunft && /leadherkunft/i.test(err.message)) {
      delete properties.leadherkunft;
      const r = await hs('/crm/v3/objects/contacts', { method: 'POST', body: { properties } });
      console.error(`[hubspot] LEADHERKUNFT_VALUE "${config.lead.herkunft}" ist in HubSpot keine gültige Option – Kontakt ohne Herkunft angelegt. Dienst neu starten, damit die Option angelegt wird.`);
      return { contact: contactFromResult(r), created: true };
    }
    throw err;
  }
}

// ------------------------------------------------------------ Kommunikation

/**
 * Protokolliert eine WhatsApp-Nachricht als Kommunikation am Kontakt.
 * direction: 'in' | 'out'
 */
export async function logWhatsAppMessage({ contactId, body, direction, timestamp, attachmentIds = [], waMessageId }) {
  const prefix = direction === 'out' ? 'Ausgehend' : 'Eingehend';
  const properties = {
    hs_communication_channel_type: 'WHATS_APP',
    hs_communication_logged_from: 'CRM',
    hs_communication_body: `[WhatsApp ${prefix}] ${body}`.trim(),
    hs_timestamp: new Date(timestamp || Date.now()).toISOString(),
  };
  if (attachmentIds.length) properties.hs_attachment_ids = attachmentIds.join(';');
  if (config.hubspot.ownerId) properties.hubspot_owner_id = config.hubspot.ownerId;

  const r = await hs('/crm/v3/objects/communications', {
    method: 'POST',
    body: {
      properties,
      associations: [
        { to: { id: Number(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: COMMUNICATION_TO_CONTACT }] },
      ],
    },
  });
  return { id: String(r.id), waMessageId };
}

/** Letzte WhatsApp-Kommunikationen eines Kontakts (neueste zuerst). */
export async function listWhatsAppHistory(contactId, limit = 20) {
  const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/communications`, { query: { limit: 500 } });
  const ids = (assoc.results || []).map((r) => String(r.toObjectId));
  if (!ids.length) return [];
  const batch = await hs('/crm/v3/objects/communications/batch/read', {
    method: 'POST',
    body: { properties: ['hs_communication_body', 'hs_communication_channel_type', 'hs_timestamp'], inputs: ids.slice(-200).map((id) => ({ id })) },
  });
  return (batch.results || [])
    .filter((r) => r.properties?.hs_communication_channel_type === 'WHATS_APP')
    .map((r) => ({ id: String(r.id), timestamp: r.properties.hs_timestamp, body: r.properties.hs_communication_body }))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);
}

// ------------------------------------------------------------------- Dateien

/** Lädt eine Datei (z. B. Sprachnachricht) privat in HubSpot hoch; liefert die File-ID. */
export async function uploadFile({ buffer, filename, mimeType }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename);
  form.append('folderPath', config.hubspot.filesFolder);
  form.append('fileName', filename);
  form.append('options', JSON.stringify({ access: 'PRIVATE', overwrite: false, duplicateValidationStrategy: 'NONE', duplicateValidationScope: 'EXACT_FOLDER' }));
  const r = await hs('/files/v3/files', { method: 'POST', body: form });
  return { id: String(r.id), url: r.url };
}

// --------------------------------------------------------- Telefon-Index-Sync

/**
 * Gleicht die Index-Property für alle (oder seit `since` geänderten) Kontakte ab.
 * Liefert Statistik. Läuft beim Start und danach im Intervall.
 */
export async function syncPhoneIndex({ since = null, log = console } = {}) {
  const idx = config.hubspot.phoneIndexProperty;
  const cc = config.lead.defaultCountryCode;
  const stats = { scanned: 0, updated: 0, pages: 0 };
  const filters = [];
  if (since) filters.push({ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(new Date(since).getTime()) });

  let after;
  const pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const inputs = pending.splice(0, pending.length);
    await hs('/crm/v3/objects/contacts/batch/update', { method: 'POST', body: { inputs } });
    stats.updated += inputs.length;
  };

  do {
    const body = {
      filterGroups: filters.length ? [{ filters }] : [],
      properties: ['phone', 'mobilephone', 'hs_whatsapp_phone_number', idx],
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;
    const page = await hs('/crm/v3/objects/contacts/search', { method: 'POST', body });
    stats.pages += 1;
    for (const r of page.results || []) {
      stats.scanned += 1;
      const p = r.properties || {};
      const e164 = normalizePhone(p.hs_whatsapp_phone_number, cc) || normalizePhone(p.mobilephone, cc) || normalizePhone(p.phone, cc);
      if (e164 && p[idx] !== e164) pending.push({ id: String(r.id), properties: { [idx]: e164 } });
      if (pending.length >= 100) await flush();
    }
    after = page.paging?.next?.after;
    if (stats.pages > 120) { log.warn('[sync] Abbruch nach 120 Seiten (HubSpot-Suchlimit).'); break; }
  } while (after);
  await flush();
  return stats;
}
