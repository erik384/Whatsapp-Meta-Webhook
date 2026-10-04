import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMatchingContact } from '../src/hubspot.js';

test('pickMatchingContact vergleicht normalisiert und bevorzugt indexierte Kontakte', () => {
  const candidates = [
    { id: '1', properties: { phone: '0172-6748792', lastmodifieddate: '2026-01-01' } },
    { id: '2', properties: { mobilephone: '+49 172 6748792', whatsapp_e164: '+491726748792', lastmodifieddate: '2025-01-01' } },
    { id: '3', properties: { phone: '+491726748793' } },
  ];
  assert.equal(pickMatchingContact(candidates, '+491726748792').id, '2');
  assert.equal(pickMatchingContact(candidates.slice(0, 1), '+491726748792').id, '1');
  assert.equal(pickMatchingContact(candidates, '+491700000000'), null);
  assert.equal(pickMatchingContact([], '+491700000000'), null);
});
