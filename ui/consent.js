// "Is everyone on the call told it is being recorded?" Shared by the app window and the floating recorder.
import { api } from './api.js';

export const getConsent = async (noteId) => (await api('GET', `/api/notes/${encodeURIComponent(noteId)}`)).consent;
export const setConsent = (noteId, consent) => api('PATCH', `/api/notes/${encodeURIComponent(noteId)}`, { consent });

// Put the notice on the clipboard, ready for the meeting chat; copying it counts as announcing.
export async function copyNotice(noteId) {
  const { text } = await api('GET', '/api/consent/notice');
  await navigator.clipboard.writeText(text);
  await setConsent(noteId, 'announced');
  return text;
}
