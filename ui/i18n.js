// UI strings are written in English in the code; other languages map English → translation.
// A missing translation falls back to English, never to a raw key.
import { PT } from './i18n-pt.js';
import { esc } from './md.js';

const DICTS = { pt: PT };
let lang = 'en';
export const setLang = (l) => { lang = l === 'pt' ? 'pt' : 'en'; document.documentElement.lang = lang; };
export const getLang = () => lang;
export const t = (s, vars) => {
  let out = (lang !== 'en' && DICTS[lang]?.[s]) || s;
  // a function, not the value: a string replacement would expand $& / $' / $` written in a name
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, () => String(v));
  return out;
};
// For innerHTML: the translation is ours, the variables (a channel name, a source, what was typed) are escaped
export const tHtml = (s, vars) => t(s, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, esc(String(v))])));
