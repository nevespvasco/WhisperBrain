#!/usr/bin/env node
'use strict';
// WhisperBrain as an MCP server (read-only). Add it to an MCP client, for example in Claude Desktop's config:
//   { "mcpServers": { "whisperbrain": { "command": "node", "args": ["/path/to/whisperbrain/scripts/mcp-server.js"] } } }
// or:  claude mcp add whisperbrain -- node /path/to/whisperbrain/scripts/mcp-server.js
// --data <folder> to point at another data folder (default: the app's own).
const os = require('node:os');
const path = require('node:path');
const { BrainReader, serve } = require('../src/mcp/server');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const dataDir = arg('data', process.env.WHISPERBRAIN_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'whisperbrain'));
try { serve(BrainReader.open(path.join(dataDir, 'whisperbrain.sqlite'))); } catch (e) { console.error(`whisperbrain mcp: ${e.message}`); process.exit(1); }
