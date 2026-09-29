const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const serverPath = resolve(__dirname, '../src/server.ts');
const v2Path = resolve(__dirname, '../src/aiAssistantV2.ts');

if (!existsSync(v2Path)) throw new Error('src/aiAssistantV2.ts is missing');

let v2 = readFileSync(v2Path, 'utf8');
const looseStoreInfo = `type StoreInfo = {\n  storeName?: string;\n  menuUrl?: string;\n  autoReplyMessage?: string;\n  openingHours?: Record<string, unknown> | null;\n  timezone?: string;\n  isOpen?: boolean | null;\n};`;
const alignedStoreInfo = `type StoreOpeningHour = {\n  enabled?: boolean;\n  open?: string;\n  close?: string;\n};\n\ntype StoreInfo = {\n  storeName?: string;\n  menuUrl?: string;\n  autoReplyMessage?: string;\n  openingHours?: Record<string, StoreOpeningHour> | null;\n  timezone?: string;\n  isOpen?: boolean | null;\n};`;

if (v2.includes(looseStoreInfo)) {
  v2 = v2.replace(looseStoreInfo, alignedStoreInfo);
  writeFileSync(v2Path, v2, 'utf8');
  console.log('Aligned Gemini V2 StoreInfo type with legacy assistant');
} else if (!v2.includes('type StoreOpeningHour =')) {
  throw new Error('Could not align Gemini V2 StoreInfo type');
}

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
