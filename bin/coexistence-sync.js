#!/usr/bin/env node
// Coexistence: nach dem Verbinden der WhatsApp-Business-App innerhalb von 24 h ausführen.
//   node bin/coexistence-sync.js contacts   (zuerst)
//   node bin/coexistence-sync.js history    (danach; Verlauf der letzten 6 Monate kommt per Webhook in Chunks)
import { requestSmbAppSync } from '../src/whatsapp.js';

const what = process.argv[2];
if (!['contacts', 'history'].includes(what)) {
  console.error('Aufruf: node bin/coexistence-sync.js contacts|history');
  process.exit(1);
}
try {
  const r = await requestSmbAppSync(what === 'contacts' ? 'smb_app_state_sync' : 'history');
  console.log(JSON.stringify(r, null, 2));
} catch (err) {
  console.error('Fehler:', err.message);
  process.exitCode = 1;
}
