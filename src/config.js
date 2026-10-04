// Zentrale Konfiguration aus Umgebungsvariablen.
// Fehlende Pflichtwerte werden beim Start gemeldet (siehe assertConfig).

const env = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

const bool = (name, fallback) => {
  const v = env(name, '');
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(v.toLowerCase());
};

export const config = {
  port: Number(env('PORT', '3000')),
  verifyToken: env('VERIFY_TOKEN'),
  apiKey: env('API_KEY'),
  mcpPathSecret: env('MCP_PATH_SECRET'),

  meta: {
    appSecret: env('META_APP_SECRET'),
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    graphVersion: env('GRAPH_API_VERSION', 'v25.0'),
    markAsRead: bool('MARK_AS_READ', true),
  },

  hubspot: {
    token: env('HUBSPOT_TOKEN'),
    portalId: env('HUBSPOT_PORTAL_ID', '26200447'),
    ownerId: env('HUBSPOT_OWNER_ID'),
    phoneIndexProperty: env('HUBSPOT_PHONE_INDEX_PROPERTY', 'whatsapp_e164'),
    syncIntervalMinutes: Number(env('HUBSPOT_SYNC_INTERVAL_MINUTES', '15')),
    uploadMedia: bool('UPLOAD_MEDIA_TO_HUBSPOT', true),
    filesFolder: env('HUBSPOT_FILES_FOLDER', '/whatsapp'),
  },

  lead: {
    policy: env('LEAD_POLICY', 'inbound'), // inbound | classify | never
    status: env('LEAD_STATUS', 'NEW'),
    lifecycleStage: env('LIFECYCLE_STAGE', 'lead'),
    herkunft: env('LEADHERKUNFT_VALUE'),
    defaultCountryCode: env('DEFAULT_COUNTRY_CODE', '49'),
  },

  transcribe: {
    openaiKey: env('OPENAI_API_KEY'),
    model: env('TRANSCRIBE_MODEL', 'gpt-4o-transcribe'),
    language: env('TRANSCRIBE_LANGUAGE', 'de'),
  },

  claude: {
    apiKey: env('ANTHROPIC_API_KEY'),
    model: env('CLAUDE_MODEL', 'claude-opus-5-5'),
  },

  stateFile: env('STATE_FILE', './data/state.json'),
};

/** Liefert eine Liste fehlender Pflichtwerte (leer = alles da). */
export function missingConfig() {
  const missing = [];
  if (!config.verifyToken) missing.push('VERIFY_TOKEN');
  if (!config.meta.token) missing.push('WHATSAPP_TOKEN');
  if (!config.meta.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!config.hubspot.token) missing.push('HUBSPOT_TOKEN');
  if (!config.apiKey && !config.mcpPathSecret) missing.push('API_KEY (oder MCP_PATH_SECRET)');
  if (config.lead.policy === 'classify' && !config.claude.apiKey) missing.push('ANTHROPIC_API_KEY (LEAD_POLICY=classify)');
  if (!['inbound', 'classify', 'never'].includes(config.lead.policy)) missing.push(`LEAD_POLICY ungültig: ${config.lead.policy}`);
  return missing;
}
