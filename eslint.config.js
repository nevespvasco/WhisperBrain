'use strict';
// A minimal static check: undefined names (real bugs: a typo or a missing require throws only when that line runs) and unused
// variables (a warning). Run it with `npm run lint`; CI runs the same pinned ESLint through npx, so there is no devDependency.
const { createRequire } = require('node:module');

// `globals` (the lists of browser and Node names) comes with the ESLint that is running, which npx keeps outside the project
const globals = createRequire(process.argv[1] || __filename)('globals');

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'build/**', '.models/**', '.eval/**', 'spikes/**'] },
  {
    files: ['src/**/*.js', 'electron/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },
  {
    // sandboxed preload scripts: a browser page with Electron's limited require
    files: ['electron/*-preload.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['ui/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
    rules,
  },
  {
    files: ['ui/pcm-worklet.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.audioWorklet, sampleRate: 'readonly', currentTime: 'readonly', currentFrame: 'readonly' } },
  },
];
