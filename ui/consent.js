// "Is everyone on the call told it is being recorded?" Shared by the app window and the floating recorder.
import { api } from './api.js';

export const getConsent = async (noteId) => (await api('GET', `/api/notes/${encodeURIComponent(noteId)}`)).consent;
export const setConsent = (noteId, consent) => api('PATCH', `/api/notes/${encodeURIComponent(noteId)}`, { consent });

// Put the notice on the clipboard, ready for the meeting chat. Copying it is not telling anyone: the person says so
// afterwards ("I told them"). Rejects when the clipboard is not available.
export async function copyNotice() {
  const { text } = await api('GET', '/api/consent/notice');
  // The floating recorder cannot take focus, so there the main process owns the clipboard write.
  if (window.wbWidget?.copyText) await window.wbWidget.copyText(text);
  else await navigator.clipboard.writeText(text);
  return text;
}
