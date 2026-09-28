const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const serverPath = resolve(__dirname, '../src/server.ts');
const v2Path = resolve(__dirname, '../src/aiAssistantV2.ts');

if (!existsSync(v2Path)) throw new Error('src/aiAssistantV2.ts is missing');

let current = readFileSync(serverPath, 'utf8');
const oldImport = 'import { handleAiAssistantMessage } from "./aiAssistant.js";';
const newImport = 'import { handleAiAssistantMessage } from "./aiAssistantV2.js";';

if (current.includes(newImport)) {
  console.log('Conversational Gemini V2 routing is already present');
  process.exit(0);
}
if (!current.includes(oldImport)) {
  throw new Error('Could not locate AI assistant import after base patches');
}

current = current.replace(oldImport, newImport);
writeFileSync(serverPath, current, 'utf8');
console.log('Routed WhatsApp AI through conversational Gemini V2');
