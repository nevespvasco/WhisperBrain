'use strict';
// The sentence a person pastes into the meeting chat (or says aloud) so the others know the call is being recorded.
// Templates, not legal advice: what must be said depends on where the people are, and the person recording is the one
// who answers for it. The presets only change how much is said:
//   general  say that it is recorded, and let people object
//   eu       ... and what happens to the recording (it stays on this computer and goes on request)
//   us       ... and ask for agreement, for places where every party has to consent
const PRESETS = ['general', 'eu', 'us'];

const TEXT = {
  en: {
    base: 'Heads up: I am recording this meeting with WhisperBrain to take notes. If you would rather I did not, please say so and I will stop.',
    eu: 'The recording stays on my computer and I will delete it if you ask.',
    us: 'By staying on the call you agree to be recorded.',
  },
  pt: {
    base: 'Aviso: estou a gravar esta reunião com o WhisperBrain para tirar notas. Se preferirem que não o faça, digam-me e paro.',
    eu: 'A gravação fica no meu computador e apago-a se pedirem.',
    us: 'Ao permanecerem na chamada, aceitam ser gravados.',
  },
};

function noticeText({ preset = 'general', lang = 'en' } = {}) {
  const t = TEXT[lang] || TEXT.en;
  return [t.base, preset === 'eu' ? t.eu : preset === 'us' ? t.us : ''].filter(Boolean).join(' ');
}

module.exports = { noticeText, PRESETS };
