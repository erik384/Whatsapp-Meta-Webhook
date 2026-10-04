import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhook } from '../src/whatsapp.js';
import { mergeEnumOption } from '../src/hubspot.js';

const meta = { display_phone_number: '4940123456', phone_number_id: '1' };

test('smb_message_echoes: Nachrichten aus der Business-App werden als ausgehend erkannt', () => {
  const body = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'smb_message_echoes', value: { metadata: meta, message_echoes: [
    { from: '4940123456', to: '491711444744', id: 'wamid.e1', timestamp: '1759600100', type: 'text', text: { body: 'Wir kommen Donnerstag' } },
    { from: '4940123456', to: '491711444744', id: 'wamid.e2', timestamp: '1759600200', type: 'revoke', revoke: { original_message_id: 'wamid.e1' } },
  ] } }] }] };
  const [e1, e2] = parseWebhook(body);
  assert.equal(e1.kind, 'echo');
  assert.equal(e1.direction, 'out');
  assert.equal(e1.from, '491711444744', 'Gegenstelle ist der Kunde');
  assert.equal(e1.text, 'Wir kommen Donnerstag');
  assert.match(e2.text, /zurückgezogen/);
});

test('history: Richtung aus from_me bzw. Thread-ID', () => {
  const body = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'history', value: { metadata: meta, history: [{ metadata: { phase: 0, chunk_order: 1, progress: 50 }, threads: [{ id: '491711444744', messages: [
    { from: '491711444744', id: 'wamid.h1', timestamp: '1750000000', type: 'text', text: { body: 'Hallo' }, history_context: { status: 'read' } },
    { from: '4940123456', to: '491711444744', id: 'wamid.h2', timestamp: '1750000100', type: 'text', text: { body: 'Moin' }, history_context: { from_me: true, status: 'delivered' } },
    { from: '4940123456', to: '491711444744', id: 'wamid.h3', timestamp: '1750000200', type: 'text', text: { body: 'ohne from_me' }, history_context: { status: 'delivered' } },
  ] }] }] } }] }] };
  const [h1, h2, h3] = parseWebhook(body);
  assert.equal(h1.kind, 'history');
  assert.equal(h1.direction, 'in');
  assert.equal(h2.direction, 'out');
  assert.equal(h3.direction, 'out');
  assert.deepEqual(h1.chunk, { phase: 0, chunk_order: 1, progress: 50 });
  assert.equal(h1.from, '491711444744');
});

test('smb_app_state_sync: Adressbuch-Einträge', () => {
  const body = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'smb_app_state_sync', value: { metadata: meta, state_sync: [
    { type: 'contact', contact: { full_name: 'Michael Quast', first_name: 'Michael', phone_number: '491726748792' }, action: 'add', metadata: { timestamp: '1759600000' } },
    { type: 'something_else' },
  ] } }] }] };
  const events = parseWebhook(body);
  assert.equal(events.length, 1);
  assert.deepEqual({ kind: events[0].kind, phone: events[0].phone, name: events[0].fullName, action: events[0].action }, { kind: 'contact', phone: '491726748792', name: 'Michael Quast', action: 'add' });
});

test('mergeEnumOption ergänzt Leadherkunft nur einmal', () => {
  const options = [{ label: 'Google', value: 'Google', displayOrder: 0 }];
  const first = mergeEnumOption(options, 'WhatsApp');
  assert.ok(first.added);
  assert.equal(first.options.length, 2);
  assert.deepEqual(first.options[1], { label: 'WhatsApp', value: 'WhatsApp', displayOrder: 1, hidden: false });
  const second = mergeEnumOption(first.options, 'WhatsApp');
  assert.ok(!second.added);
  assert.equal(second.options.length, 2);
});
