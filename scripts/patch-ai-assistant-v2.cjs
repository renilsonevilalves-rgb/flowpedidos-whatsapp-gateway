const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const serverPath = resolve(__dirname, '../src/server.ts');
const v2Path = resolve(__dirname, '../src/aiAssistantV2.ts');

if (!existsSync(v2Path)) throw new Error('src/aiAssistantV2.ts is missing');

let v2 = readFileSync(v2Path, 'utf8');
const looseStoreInfo = `type StoreInfo = {\n  storeName?: string;\n  menuUrl?: string;\n  autoReplyMessage?: string;\n  openingHours?: Record<string, unknown> | null;\n  timezone?: string;\n  isOpen?: boolean | null;\n};`;
const alignedStoreInfo = `type StoreOpeningHour = {\n  enabled?: boolean;\n  open?: string;\n  close?: string;\n};\n\ntype StoreInfo = {\n  storeName?: string;\n  menuUrl?: string;\n  autoReplyMessage?: string;\n  openingHours?: Record<string, StoreOpeningHour> | null;\n  timezone?: string;\n  isOpen?: boolean | null;\n  capabilities?: { ai_assistant?: boolean } | null;\n};`;

if (v2.includes(looseStoreInfo)) {
  v2 = v2.replace(looseStoreInfo, alignedStoreInfo);
  console.log('Aligned Gemini V2 StoreInfo type with legacy assistant and plan capability');
} else if (!v2.includes('type StoreOpeningHour =')) {
  throw new Error('Could not align Gemini V2 StoreInfo type');
}

if (!v2.includes('capabilities?: { ai_assistant?: boolean } | null;')) {
  const capabilityTypeMarker = `  isOpen?: boolean | null;\n};`;
  if (!v2.includes(capabilityTypeMarker)) throw new Error('Could not add AI plan capability to StoreInfo');
  v2 = v2.replace(capabilityTypeMarker, `  isOpen?: boolean | null;\n  capabilities?: { ai_assistant?: boolean } | null;\n};`);
}

const simplePreview = `function buildPreviewText(_order: OrderSummary, preview: ChangePreview) {
  const operations = Array.isArray(preview.operations) ? preview.operations : [];
  const actions = operations.map((operation) => {
    const quantity = Number(operation.quantity) || 1;
    const product = clean(operation.product);
    return operation.action === "add_item"
      ? \`colocar *\${quantity}x \${product}*\`
      : \`tirar *\${quantity}x \${product}*\`;
  });
  const description = actions.length === 0
    ? "revisar esta alteração"
    : actions.length === 1
      ? actions[0]
      : \`\${actions.slice(0, -1).join(", ")} e \${actions.at(-1)}\`;
  const sentence = description.charAt(0).toUpperCase() + description.slice(1);
  return [
    \`\${sentence}.\`,
    "",
    \`*Total: \${money(preview.proposedTotal)}*\`,
    "",
    "Está certo?",
    "Responda *SIM* para confirmar ou *NÃO* para cancelar.",
  ].join("\\n");
}`;
const previewPattern = /function buildPreviewText\(order: OrderSummary, preview: ChangePreview\) \{[\s\S]*?\n\}\n\nasync function preparePreview/;
if (previewPattern.test(v2)) {
  v2 = v2.replace(previewPattern, `${simplePreview}\n\nasync function preparePreview`);
  console.log('Simplified WhatsApp order-change confirmation copy');
} else if (!v2.includes('Responda *SIM* para confirmar ou *NÃO* para cancelar.')) {
  throw new Error('Could not simplify Gemini V2 order-change confirmation');
}

// Plan entitlement must be checked before either Gemini V2 or the legacy AI
// path is allowed to run. Missing capability data is tolerated only for the
// rolling-deploy window while the additive backend migration is not present.
const earlyLegacyFallback = `export async function handleAiAssistantMessage(params: AiAssistantParams): Promise<boolean> {\n  if (!GEMINI_API_KEY) return handleLegacyAiAssistantMessage(params);\n  const text = clean(params.text);`;
const capabilityAwareStart = `export async function handleAiAssistantMessage(params: AiAssistantParams): Promise<boolean> {\n  const text = clean(params.text);`;
if (v2.includes(earlyLegacyFallback)) {
  v2 = v2.replace(earlyLegacyFallback, capabilityAwareStart);
} else if (!v2.includes(capabilityAwareStart)) {
  throw new Error('Could not move legacy AI fallback behind plan entitlement');
}

const currentStateMarker = `  const current = pendingChanges.get(key) || null;\n\n  if (inFlight.has(key)) return false;`;
const currentStateWithLoadGuard = `  const current = pendingChanges.get(key) || null;\n  let storeInfoLoaded = false;\n\n  if (inFlight.has(key)) return false;`;
if (v2.includes(currentStateMarker)) {
  v2 = v2.replace(currentStateMarker, currentStateWithLoadGuard);
} else if (!v2.includes('let storeInfoLoaded = false;')) {
  throw new Error('Could not add store-info fail-closed guard');
}

const storeInfoMarker = `    const storeInfo = await params.getStoreInfo();\n    if (current) {`;
const gatedStoreInfo = `    const storeInfo = await params.getStoreInfo();\n    storeInfoLoaded = true;\n    if (storeInfo?.capabilities?.ai_assistant === false) {\n      pendingChanges.delete(key);\n      params.logger.info({ sessionId: params.sessionId }, "[AI-Assistant-V2] AI disabled by plan capability");\n      return false;\n    }\n    if (!GEMINI_API_KEY) return await handleLegacyAiAssistantMessage(params);\n    if (current) {`;
if (v2.includes(storeInfoMarker)) {
  v2 = v2.replace(storeInfoMarker, gatedStoreInfo);
} else if (!v2.includes('[AI-Assistant-V2] AI disabled by plan capability')) {
  throw new Error('Could not add AI plan entitlement gate');
}

const catchMarker = `    params.logger.warn({ error: error?.message || error, sessionId: params.sessionId, remoteJid: params.customerJid }, "[AI-Assistant-V2] Conversational order-change flow failed");\n    if (pendingChanges.has(key)) {`;
const failClosedCatch = `    params.logger.warn({ error: error?.message || error, sessionId: params.sessionId, remoteJid: params.customerJid }, "[AI-Assistant-V2] Conversational order-change flow failed");\n    if (!storeInfoLoaded) return false;\n    if (pendingChanges.has(key)) {`;
if (v2.includes(catchMarker)) {
  v2 = v2.replace(catchMarker, failClosedCatch);
} else if (!v2.includes('if (!storeInfoLoaded) return false;')) {
  throw new Error('Could not make AI entitlement lookup fail closed');
}

writeFileSync(v2Path, v2, 'utf8');

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
