#!/usr/bin/env node
'use strict';
// node scripts/retrieval-eval.js --set my-questions.json [--data <folder>] [--k 5]
// my-questions.json: [{ "q": "o que ficou decidido sobre o preço?", "expect": ["Preço", "Atlas"] }, ...]
// Prints recall@k and MRR for the words index of the app's own data. Run it again after changing chunking or the embedding model.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/core/db');
const { Notes } = require('../src/core/notes');
const { ItemStore } = require('../src/items/store');
const { ChunkIndex } = require('../src/search/index');
const { evaluate } = require('../src/search/eval');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
(async () => {
  const setFile = arg('set');
  if (!setFile) { console.error('Usage: node scripts/retrieval-eval.js --set questions.json [--data folder] [--k 5]'); process.exit(2); }
  const dataDir = arg('data', process.env.WHISPERBRAIN_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'whisperbrain'));
  const db = open(path.join(dataDir, 'whisperbrain.sqlite'));
  const notes = new Notes(db), items = new ItemStore(db);
  const index = new ChunkIndex({ db, notes, items });
  while (index.syncBatch(200).left) { /* bring the index up to date */ }
  const k = Number(arg('k', 5));
  const r = await evaluate(JSON.parse(fs.readFileSync(setFile, 'utf8')), (q) => index.search(q, { limit: 10 }), { k });
  for (const row of r.rows) console.log(`${row.found === row.wanted ? 'ok  ' : 'MISS'} ${row.found}/${row.wanted} first@${row.firstRank ?? '-'}  ${row.q}`);
  console.log(`\nrecall@${r.k} ${r.recallAtK}   MRR ${r.mrr}   (${r.cases} questions)`);
  db.close();
})();
