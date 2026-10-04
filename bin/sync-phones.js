#!/usr/bin/env node
// Einmaliger kompletter Abgleich der Telefon-Index-Property: node bin/sync-phones.js [--incremental]
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ensurePhoneIndexProperty, syncPhoneIndex } from '../src/hubspot.js';

const store = new Store(config.stateFile);
const incremental = process.argv.includes('--incremental');
const started = new Date().toISOString();
const prop = await ensurePhoneIndexProperty();
console.log(`Index-Property ${prop.name} ${prop.created ? 'angelegt' : 'vorhanden'}.`);
const stats = await syncPhoneIndex({ since: incremental ? store.lastSync : null });
store.lastSync = started;
store.flush();
console.log(JSON.stringify(stats));
