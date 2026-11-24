// UI strings are written in English in the code; other languages map English → translation.
// A missing translation falls back to English, never to a raw key.
import { PT } from './i18n-pt.js';

const DICTS = { pt: PT };
let lang = 'en';
export const setLang = (l) => { lang = l === 'pt' ? 'pt' : 'en'; document.documentElement.lang = lang; };
export const getLang = () => lang;
export const t = (s, vars) => {
  let out = (lang !== 'en' && DICTS[lang]?.[s]) || s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
};
