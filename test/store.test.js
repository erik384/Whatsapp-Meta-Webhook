import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('Store dedupliziert, merkt Konversationen und persistiert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-'));
  const file = path.join(dir, 'state.json');
  const store = new Store(file);
  assert.ok(store.markProcessed('wamid.1'));
  assert.ok(!store.markProcessed('wamid.1'));
  store.updateConversation('+491711444744', { contactId: '42', lastInboundAt: '2026-10-04T10:00:00.000Z' });
  store.updateConversation('+491700000000', { contactId: null, lastInboundAt: '2026-10-04T11:00:00.000Z' });
  assert.equal(store.recentConversations(5)[0].phone, '+491700000000');
  store.flush();
  const again = new Store(file);
  assert.equal(again.getConversation('+491711444744').contactId, '42');
  assert.ok(!again.markProcessed('wamid.1'));
  fs.rmSync(dir, { recursive: true, force: true });
});
