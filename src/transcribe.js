// Transkription von Sprachnachrichten über die OpenAI-Audio-API (optional).
// Ohne OPENAI_API_KEY wird null geliefert und die Nachricht nur als Datei abgelegt.
import { config } from './config.js';

export function transcriptionAvailable() {
  return Boolean(config.transcribe.openaiKey);
}

export async function transcribeAudio({ buffer, mimeType, filename = 'voice.ogg' }) {
  if (!transcriptionAvailable()) return null;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), filename);
  form.append('model', config.transcribe.model);
  if (config.transcribe.language) form.append('language', config.transcribe.language);
  form.append('response_format', 'json');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.transcribe.openaiKey}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Transkription fehlgeschlagen (${res.status}): ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text).text?.trim() || null;
  } catch {
    return text.trim() || null;
  }
}
