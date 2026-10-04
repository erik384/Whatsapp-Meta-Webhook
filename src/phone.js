// Telefonnummern-Normalisierung auf E.164 (+49...).
// HubSpot-Kontakte enthalten alle denkbaren Schreibweisen:
// "+491711444744", "01638684656", "0172-6748792", "‪+49 170 3022778‬", "+49543 359 38 31".
// WhatsApp liefert wa_id ohne Plus: "491711444744".

const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Normalisiert eine Nummer auf E.164 ("+4917..."). Liefert null, wenn keine
 * plausible Nummer erkennbar ist.
 */
export function normalizePhone(raw, defaultCountryCode = '49') {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(INVISIBLE, '').trim();
  if (!s) return null;

  const hasPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    // "+49 (0)176..." -> Null nach Ländervorwahl entfernen
    digits = stripTrunkZero(digits, defaultCountryCode);
  } else if (digits.startsWith('00')) {
    digits = stripTrunkZero(digits.slice(2), defaultCountryCode);
  } else if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.replace(/^0+/, '');
  } else if (digits.startsWith(defaultCountryCode) && digits.length >= 11) {
    // bereits international ohne Plus (so liefert es WhatsApp)
    digits = stripTrunkZero(digits, defaultCountryCode);
  } else if (digits.length >= 9 && digits.length <= 11) {
    // nationale Nummer ohne führende Null
    digits = defaultCountryCode + digits;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
}

function stripTrunkZero(digits, cc) {
  if (digits.startsWith(cc + '0')) return cc + digits.slice(cc.length + 1);
  return digits;
}

/** E.164 ohne Plus, wie WhatsApp es als "to"/"wa_id" erwartet. */
export function toWaId(e164) {
  return e164 ? e164.replace(/^\+/, '') : null;
}

/** Nationale Schreibweise ("0176...") für Suchanfragen. */
export function toNational(e164, defaultCountryCode = '49') {
  if (!e164) return null;
  const digits = e164.replace(/^\+/, '');
  if (digits.startsWith(defaultCountryCode)) return '0' + digits.slice(defaultCountryCode.length);
  return null;
}

export function phonesMatch(a, b, defaultCountryCode = '49') {
  const na = normalizePhone(a, defaultCountryCode);
  const nb = normalizePhone(b, defaultCountryCode);
  return Boolean(na && nb && na === nb);
}

/** Zerlegt einen WhatsApp-Profilnamen in Vor-/Nachname. */
export function splitName(name) {
  const clean = String(name || '').replace(INVISIBLE, '').trim();
  if (!clean) return { firstname: '', lastname: '' };
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts.slice(0, -1).join(' '), lastname: parts.at(-1) };
}
