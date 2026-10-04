#!/usr/bin/env node
// CLI: node bin/send.js "+49 170 1234567" "Hallo, hier ist Bodenfix ..."
//      node bin/send.js "+49 170 1234567" --template hello_world [--lang de]
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createOutbound } from '../src/outbound.js';

const [to, ...rest] = process.argv.slice(2);
if (!to || !rest.length) {
  console.error('Aufruf: node bin/send.js <nummer> "<text>" | <nummer> --template <name> [--lang de]');
  process.exit(1);
}
const store = new Store(config.stateFile);
const outbound = createOutbound({ store });
let payload;
if (rest[0] === '--template') {
  const langIdx = rest.indexOf('--lang');
  payload = { to, template: { name: rest[1], language: langIdx >= 0 ? rest[langIdx + 1] : 'de' } };
} else {
  payload = { to, text: rest.join(' ') };
}
try {
  console.log(JSON.stringify(await outbound.sendMessage(payload), null, 2));
} catch (err) {
  console.error('Fehler:', err.message);
  process.exitCode = 1;
} finally {
  store.flush();
}
