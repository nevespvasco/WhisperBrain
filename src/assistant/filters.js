'use strict';
// What a line from the other side of the call is, before the assistant spends any AI on it: a filler, a backchannel, a
// sentence cut off mid-way, a request to repeat, the user reading a suggestion aloud, the same question heard again, or a
// real question. Plain text rules (English and European Portuguese), no AI, so they run on every line.

const words = (text) => String(text ?? '').toLowerCase().normalize('NFC').replace(/[‐-―]/g, '-').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
const flat = (text) => words(text).join(' ');

const FILLER = new Set(['ok', 'okay', 'uh', 'huh', 'um', 'umm', 'uhm', 'er', 'erm', 'hmm', 'hm', 'mm', 'mhm', 'mm-hmm', 'uh-huh', 'right', 'yeah', 'yes', 'yep', 'yup', 'sure', 'great', 'cool', 'nice', 'alright', 'thanks', 'thank', 'you', 'got', 'it', 'i', 'see', 'perfect', 'good',
  'pois', 'certo', 'sim', 'está', 'bem', 'obrigado', 'obrigada', 'ah', 'hum', 'aham', 'uhum', 'exato', 'exatamente', 'claro', 'boa', 'ótimo', 'perfeito', 'percebo', 'percebi', 'pronto', 'tá', 'ya']);
const MOVE_ON = [/\b(let'?s|we can) move on\b/, /\bmoving on\b/, /\bvamos (avançar|seguir|continuar)\b/, /\bpassemos (à|a) frente\b/];
function isFiller(text) {
  const w = words(text);
  if (!w.length) return true;
  if (w.length <= 6 && MOVE_ON.some((re) => re.test(w.join(' ')))) return true;
  return w.length <= 4 && w.every((x) => FILLER.has(x));
}

const BACKCHANNEL = new Set(['mm', 'mmm', 'hmm', 'hm', 'mhm', 'mm-hmm', 'uh-huh', 'uh', 'huh', 'yeah', 'yep', 'yup', 'aham', 'hum', 'uhum', 'sim', 'ok', 'okay', 'right', 'pois', 'ya', 'tá']);
function isBackchannel(text) {
  const w = words(text);
  return w.length > 0 && w.length <= 3 && w.every((x) => BACKCHANNEL.has(x));
}

// Words a sentence does not end on: hesitations, and the little words that always lead into something more.
const HESITATION = new Set(['um', 'umm', 'uh', 'uhm', 'er', 'erm', 'hmm', 'hum', 'like', 'tipo', 'portanto', 'então', 'so']);
const LEADS_ON = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'but', 'with', 'for', 'about', 'how', 'that', 'your', 'our', 'my', 'is', 'are', 'in', 'on', 'at', 'from', 'which', 'what',
  'de', 'da', 'do', 'das', 'dos', 'e', 'ou', 'mas', 'com', 'para', 'por', 'que', 'um', 'uma', 'o', 'os', 'as', 'no', 'na', 'em', 'qual', 'como', 'se', 'ao', 'à']);
function endsDangling(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/(…|\.\.\.|[—–-])$/.test(t)) return true;
  if (/[.?!？！。]$/.test(t)) return false;
  const w = words(t);
  const last = w[w.length - 1];
  return !!last && (HESITATION.has(last) || LEADS_ON.has(last));
}

const REPEAT = [/\brepeat (that|it|the question|yourself)\b/, /\bsay (that|it) again\b/, /\bcome again\b/, /^(sorry,? )?pardon\b/, /\b(podes|pode|podia|poderia) repetir\b/, /^repete\b/, /\bnão (percebi|ouvi)\b/, /\brepetir a pergunta\b/];
const isRepeatRequest = (text) => { const f = flat(text); return f.length > 0 && f.split(' ').length <= 10 && REPEAT.some((re) => re.test(f)); };

function trigrams(w) {
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}
// Share of the line's word trigrams found in one of the recent answers (0..1). Short lines count only as a whole match.
function echoOverlap(text, answers = []) {
  const w = words(text);
  if (!w.length || !answers.length) return 0;
  if (w.length < 3) return w.length === 2 && answers.some((a) => ` ${flat(a)} `.includes(` ${w.join(' ')} `)) ? 1 : 0;
  const mine = trigrams(w);
  let best = 0;
  for (const a of answers) {
    const theirs = trigrams(words(a));
    let hit = 0;
    for (const g of mine) if (theirs.has(g)) hit++;
    best = Math.max(best, hit / mine.size);
  }
  return best;
}

const TRAILING_FILLER = /( (ok|okay|right|yeah|yes|so|pois|certo|sim|então|né))+$/;
const core = (text) => flat(text).replace(TRAILING_FILLER, '');
function sameQuestion(a, b) {
  const x = core(a), y = core(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 12) return false;
  return x.startsWith(y) || y.startsWith(x);
}

const PROMPT = /^(?:(?:ok|so|right|well|now|then|pois|então|bem|ok então)\s*,?\s+)?(tell (me|us)( a (bit|little)| a bit more| more)? about|tell me more|walk me through|talk me through|take me through|describe|give me an example|explain (to me )?(how|why|what|the)|share (an|a) example|fala-me|fale-me|conta-me|conte-me|descreve|descreva|dá-me um exemplo|dê-me um exemplo|explica-me|explique-me)\b/;
const ASKS = /^(?:(?:ok|so|right|well|and|now|then|pois|então|e|bem)\s*,?\s+)?(what|how|why|when|where|who|which|whose|whom|can|could|would|will|do|does|did|is|are|was|were|have|has|should|shall|may|might|qual|quais|como|porque|porquê|por que|quando|onde|quem|quanto|quanta|quantos|quantas|o que|que|podes|pode|poderia|podia|consegues|consegue|achas|acha|sabes|sabe|tens|tem|há|será|é que)\b/;
// 'question' | 'prompt' (an invitation to talk: "tell me about…") | 'statement'
function questionKind(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'statement';
  if (/[?？؟]\s*$/.test(t)) return 'question';
  // the question may come after a short lead-in ("So, to start, tell me…", "Bom, para começar, fala-me…"): up to two clauses of at
  // most three words each are skipped. A longer clause is a statement of its own ("We moved to Kubernetes, then what happened…").
  const clauses = t.split(/[,;:]\s*/);
  for (let i = 0; i < Math.min(3, clauses.length); i++) {
    if (i > 0 && words(clauses[i - 1]).length > 3) break;
    const f = flat(clauses.slice(i).join(' '));
    if (PROMPT.test(f)) return 'prompt';
    if (ASKS.test(f)) return 'question';
  }
  return 'statement';
}

module.exports = { words, isFiller, isBackchannel, endsDangling, isRepeatRequest, echoOverlap, sameQuestion, questionKind };
