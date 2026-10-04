import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseWebhook, verifySignature, extensionFor, isReengagementError } from '../src/whatsapp.js';

const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '1', changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '4940123456', phone_number_id: '106540352242922' },
        contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: '491711444744' }],
        messages: [
          { from: '491711444744', id: 'wamid.text', timestamp: '1749416383', type: 'text', text: { body: 'Hallo, ich brauche Parkett' } },
          { from: '491711444744', id: 'wamid.audio', timestamp: '1749416390', type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true, sha256: 'x' } },
          { from: '491711444744', id: 'wamid.img', timestamp: '1749416391', type: 'image', image: { id: 'media-2', mime_type: 'image/jpeg', caption: 'Wohnzimmer' } },
        ],
        statuses: [{ id: 'wamid.out', status: 'delivered', timestamp: '1749416400', recipient_id: '491711444744' }],
      },
    }],
  }],
};

test('parseWebhook liefert Nachrichten und Status flach', () => {
  const events = parseWebhook(payload);
  assert.equal(events.length, 4);
  const [t, a, i, s] = events;
  assert.equal(t.kind, 'message');
  assert.equal(t.profileName, 'Sheena Nelson');
  assert.equal(t.text, 'Hallo, ich brauche Parkett');
  assert.equal(t.timestamp, 1749416383000);
  assert.equal(a.type, 'audio');
  assert.deepEqual(a.media, { id: 'media-1', mimeType: 'audio/ogg; codecs=opus', voice: true, filename: undefined, sha256: 'x' });
  assert.equal(i.caption, 'Wohnzimmer');
  assert.equal(s.kind, 'status');
  assert.equal(s.status, 'delivered');
});

test('parseWebhook ignoriert fremde Objekte', () => {
  assert.deepEqual(parseWebhook({ object: 'page' }), []);
  assert.deepEqual(parseWebhook(null), []);
});

test('verifySignature prüft HMAC-SHA256', () => {
  const secret = 'geheim';
  const body = Buffer.from(JSON.stringify(payload));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.ok(verifySignature(body, sig, secret));
  assert.ok(!verifySignature(body, 'sha256=' + '0'.repeat(64), secret));
  assert.ok(!verifySignature(body, undefined, secret));
  assert.ok(verifySignature(body, undefined, ''), 'ohne App-Secret keine Prüfung');
});

test('extensionFor und Re-Engagement-Erkennung', () => {
  assert.equal(extensionFor('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor(''), 'bin');
  assert.ok(isReengagementError({ code: 131047 }));
  assert.ok(isReengagementError(new Error('Re-engagement message')));
  assert.ok(!isReengagementError(new Error('Rate limit')));
});
