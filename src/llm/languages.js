'use strict';
// The languages a meeting can be translated into (Settings → Translation). `name` is English, what the model is told;
// `native` is what the language calls itself, for the picker.
const LANGUAGES = [
  ['en', 'English', 'English'], ['en-GB', 'English (UK)', 'English (UK)'], ['en-US', 'English (US)', 'English (US)'],
  ['pt', 'Portuguese', 'Português'], ['pt-PT', 'Portuguese (Portugal)', 'Português (Portugal)'], ['pt-BR', 'Portuguese (Brazil)', 'Português (Brasil)'],
  ['es', 'Spanish', 'Español'], ['fr', 'French', 'Français'], ['de', 'German', 'Deutsch'], ['it', 'Italian', 'Italiano'],
  ['nl', 'Dutch', 'Nederlands'], ['ca', 'Catalan', 'Català'], ['gl', 'Galician', 'Galego'],
  ['sv', 'Swedish', 'Svenska'], ['da', 'Danish', 'Dansk'], ['no', 'Norwegian', 'Norsk'], ['fi', 'Finnish', 'Suomi'], ['is', 'Icelandic', 'Íslenska'],
  ['pl', 'Polish', 'Polski'], ['cs', 'Czech', 'Čeština'], ['sk', 'Slovak', 'Slovenčina'], ['sl', 'Slovenian', 'Slovenščina'], ['hr', 'Croatian', 'Hrvatski'], ['sr', 'Serbian', 'Српски'],
  ['hu', 'Hungarian', 'Magyar'], ['ro', 'Romanian', 'Română'], ['bg', 'Bulgarian', 'Български'], ['el', 'Greek', 'Ελληνικά'],
  ['lt', 'Lithuanian', 'Lietuvių'], ['lv', 'Latvian', 'Latviešu'], ['et', 'Estonian', 'Eesti'],
  ['ru', 'Russian', 'Русский'], ['uk', 'Ukrainian', 'Українська'], ['tr', 'Turkish', 'Türkçe'],
  ['ar', 'Arabic', 'العربية'], ['he', 'Hebrew', 'עברית'], ['fa', 'Persian', 'فارسی'],
  ['hi', 'Hindi', 'हिन्दी'], ['bn', 'Bengali', 'বাংলা'], ['ur', 'Urdu', 'اردو'], ['ta', 'Tamil', 'தமிழ்'],
  ['th', 'Thai', 'ไทย'], ['vi', 'Vietnamese', 'Tiếng Việt'], ['id', 'Indonesian', 'Bahasa Indonesia'], ['ms', 'Malay', 'Bahasa Melayu'],
  ['zh', 'Chinese (Simplified)', '简体中文'], ['zh-TW', 'Chinese (Traditional)', '繁體中文'], ['ja', 'Japanese', '日本語'], ['ko', 'Korean', '한국어'],
].map(([code, name, native]) => ({ code, name, native }));

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
const isLanguage = (code) => BY_CODE.has(code);
const languageName = (code) => BY_CODE.get(code)?.name || String(code);

module.exports = { LANGUAGES, isLanguage, languageName };
