import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, toWaId, toNational, phonesMatch, splitName } from '../src/phone.js';

test('normalisiert die Schreibweisen aus dem HubSpot-Bestand', () => {
  const cases = {
    '+491711444744': '+491711444744',
    '01638684656': '+491638684656',
    '0172-6748792': '+491726748792',
    '‪+49 170 3022778‬': '+491703022778',
    '+491609-957841': '+491609957841',
    '+49543 359 38 31': '+4954335938 31'.replace(' ', ''),
    '491711444744': '+491711444744', // WhatsApp wa_id ohne Plus
    '0049 170 1234567': '+491701234567',
    '+49 (0)176 1234567': '+491761234567',
    '+41 79 123 45 67': '+41791234567',
    '1711444744': '+491711444744', // national ohne führende Null
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizePhone(input), expected, `Eingabe ${JSON.stringify(input)}`);
  }
});

test('verwirft Unsinn', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('123'), null);
});

test('WhatsApp-ID und nationale Form', () => {
  assert.equal(toWaId('+491711444744'), '491711444744');
  assert.equal(toNational('+491711444744'), '01711444744');
  assert.equal(toNational('+41791234567'), null);
});

test('phonesMatch vergleicht normalisiert', () => {
  assert.ok(phonesMatch('0172-6748792', '491726748792'));
  assert.ok(!phonesMatch('0172-6748792', '0172-6748793'));
});

test('splitName', () => {
  assert.deepEqual(splitName('Peter Witthöft'), { firstname: 'Peter', lastname: 'Witthöft' });
  assert.deepEqual(splitName('Sayna Ghanat Pisheh Jahromi'), { firstname: 'Sayna Ghanat Pisheh', lastname: 'Jahromi' });
  assert.deepEqual(splitName('Erik'), { firstname: 'Erik', lastname: '' });
  assert.deepEqual(splitName(''), { firstname: '', lastname: '' });
});
