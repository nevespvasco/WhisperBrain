'use strict';
// Offline topic extraction (no LLM needed): candidate phrases are runs of content words between stop-words
// (RAKE-style), scored by frequency in the meeting × rarity across all meetings (IDF). English and Portuguese.

const STOP = new Set(`
a about above after again against all almost also although always am among an and another any anybody anyone anything
are aren around as ask asked at away back be became because become been before being below best better between both
but by came can cannot could couldn did didn do does doesn doing don done down during each either else enough even ever
every everybody everyone everything few find first for from further get gets getting give given go goes going gone got
had hadn has hasn have haven having he her here hers herself him himself his how however i if in into is isn it its itself
just keep kind know known last least less let like likely made make makes making many may maybe me might mine more most
much must my myself need needs never new next no nobody none nor not nothing now of off often oh ok okay on once one only
or other others our ours ourselves out over own part per perhaps please put quite rather re really right said same saw say
says see seem seemed seems seen several shall she should show since so some somebody someone something sometimes soon
sort still such sure take taken than thank thanks that the their theirs them themselves then there these they thing
things think this those though thought through thus to today together too took toward true try trying two under until up
upon us use used using usually very via want wanted wants was wasn way we well went were weren what whatever when where
whether which while who whole whom whose why will with within without won would wouldn yeah yes yet you your yours
yourself yourselves um uh hmm mm mhm ah eh er gonna wanna gotta kinda sorta actually basically literally totally stuff
bit lot lots guys guy mean means meaning talk talking said tell telling told look looking looked feel felt good great
nice cool awesome fine thing alright anyway anyways course definitely probably exactly obviously honestly hey hi hello
bye minute minutes second seconds hour hours day days week weeks month months year years time times today tomorrow
yesterday morning afternoon evening speaker me them people person everybody point points question questions answer
o a os as um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas para pra com sem sob sobre entre
e ou mas que se como quando onde porque porquê pois então assim também já ainda só mesmo muito muita muitos muitas pouco
mais menos bem mal sim não nao é são foi era eram ser estar está estão estava estavam ter tem têm tinha tinham há haver
ir vai vão vou fazer faz feito fazemos fiz dizer diz disse dito ver vejo visto eu tu ele ela nós vós eles elas me te lhe
nos vos lhes meu minha meus minhas teu tua seu sua seus suas nosso nossa nossos nossas este esta estes estas esse essa
esses essas aquele aquela aqueles aquelas isto isso aquilo aqui ali lá cá agora depois antes hoje amanhã ontem tudo nada
todo toda todos todas algum alguma alguns algumas nenhum nenhuma outro outra outros outras qual quais quem cada coisa
coisas tipo pronto ok okay pá acho achas sei sabes portanto aliás afinal claro exato exatamente certo vez vezes dia dias
semana semanas mês meses ano anos hora horas minuto minutos gente pessoal ah eh hum olá obrigado obrigada tá ta né
`.split(/\s+/).filter(Boolean));

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

// Phrase key used to match the same topic across meetings ("Pricing models" ≈ "pricing model").
function phraseKey(s) {
  return fold(String(s)).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

// Candidate phrases (1–3 words) with their surface forms.
function candidates(text) {
  const out = new Map(); // key -> { count, forms: Map(form -> n), caps }
  for (const sentence of String(text).split(/[.!?;:\n()\[\]{}"“”,…]+/)) {
    const toks = sentence.match(WORD) || [];
    let run = [];
    const flush = () => {
      for (let i = 0; i < run.length; i++) {
        for (let n = 1; n <= 3 && i + n <= run.length; n++) {
          const words = run.slice(i, i + n);
          if (words.some((w) => w.length < 3 && !/^\p{Lu}{2,}$/u.test(w)) || words.every((w) => /^\d/.test(w))) continue;
          const form = words.join(' ');
          const key = phraseKey(form);
          if (!key) continue;
          const e = out.get(key) || { count: 0, forms: new Map(), caps: 0, n };
          e.count++;
          e.forms.set(form, (e.forms.get(form) || 0) + 1);
          if (words.every((w) => /^\p{Lu}/u.test(w))) e.caps++;
          out.set(key, e);
        }
      }
      run = [];
    };
    for (const tok of toks) {
      const w = tok.replace(/['’]s$/i, '');
      if (STOP.has(fold(w)) || /^\d+$/.test(w)) flush(); else run.push(w);
    }
    flush();
  }
  return out;
}

// Document frequency of phrase keys over a corpus of texts.
function docFreq(texts) {
  const df = new Map();
  for (const t of texts) for (const k of candidates(t).keys()) df.set(k, (df.get(k) || 0) + 1);
  return { df, docs: texts.length };
}

// Best topics for one text. `corpus` is the docFreq of all meetings (including this one).
function extract(text, corpus = { df: new Map(), docs: 1 }, { max = 6 } = {}) {
  const cands = candidates(text);
  const scored = [];
  for (const [key, e] of cands) {
    const multi = e.n > 1;
    if (e.count < 2 && !(multi && e.caps)) continue;
    const df = corpus.df.get(key) || 1;
    const idf = Math.log(1 + (corpus.docs + 1) / df);
    // in a single-meeting corpus every phrase is "rare": frequency and length carry the score
    let score = Math.log(1 + e.count) * idf * (multi ? 1.6 + 0.2 * e.n : 1) * (e.caps ? 1.3 : 1);
    if (corpus.docs > 3 && df / corpus.docs > 0.6) score *= 0.3; // in most meetings: not a topic, just vocabulary
    const form = [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
    scored.push({ key, name: tidy(form), score, count: e.count });
  }
  scored.sort((a, b) => b.score - a.score);
  // drop phrases contained in a better one ("pricing" when "pricing model" already won)
  const picked = [];
  for (const s of scored) {
    if (picked.some((p) => p.key.includes(s.key) || s.key.includes(p.key))) continue;
    picked.push(s);
    if (picked.length >= max) break;
  }
  const top = picked[0]?.score || 1;
  return picked.map((p) => ({ name: p.name, key: p.key, weight: Math.round((p.score / top) * 100) / 100, count: p.count }));
}

const tidy = (s) => (/^\p{Ll}/u.test(s) ? s[0].toUpperCase() + s.slice(1) : s);

module.exports = { STOP, phraseKey, candidates, docFreq, extract, fold };
