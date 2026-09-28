const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
const aiAssistantPath = resolve(__dirname, "../src/aiAssistant.ts");
let current = readFileSync(serverPath, "utf8");
let aiAssistant = readFileSync(aiAssistantPath, "utf8");
let changed = false;
let aiChanged = false;

function replaceOnce(original, replacement, label) {
  if (current.includes(replacement)) return;
  if (!current.includes(original)) {
    throw new Error(`Could not locate ${label} in src/server.ts`);
  }
  current = current.replace(original, replacement);
  changed = true;
}

function replaceAiOnce(original, replacement, label) {
  if (aiAssistant.includes(replacement)) return;
  if (!aiAssistant.includes(original)) {
    throw new Error(`Could not locate ${label} in src/aiAssistant.ts`);
  }
  aiAssistant = aiAssistant.replace(original, replacement);
  aiChanged = true;
}

replaceAiOnce(
  `  const orders = Array.isArray(lookup?.data?.orders) ? lookup.data.orders as OrderSummary[] : [];`,
  `  const lookupOrdersData = (lookup as any)?.data?.orders;\n  const orders = Array.isArray(lookupOrdersData) ? lookupOrdersData as OrderSummary[] : [];`,
  "AI backend lookup result typing",
);

replaceOnce(
  `} from "@whiskeysockets/baileys";\n\nconst PORT`,
  `} from "@whiskeysockets/baileys";\nimport { handleAiAssistantMessage } from "./aiAssistant.js";\n\nconst PORT`,
  "AI assistant import",
);

replaceOnce(
  `      const isTrigger = isAutoReplyTrigger(text);`,
  `      const aiCustomerJid = getCustomerJid(msg, remoteJid);\n      const aiCustomerPhone = await resolveCustomerPhone(sock, msg, remoteJid);\n      const aiHandled = await handleAiAssistantMessage({\n        sessionId: id,\n        customerJid: aiCustomerJid,\n        customerPhone: aiCustomerPhone,\n        text,\n        getStoreInfo: async () => fetchStoreInfo(id),\n        sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },\n        logger,\n      });\n      if (aiHandled) continue;\n\n      const isTrigger = isAutoReplyTrigger(text);`,
  "AI assistant incoming-message hook",
);

if (aiChanged) {
  writeFileSync(aiAssistantPath, aiAssistant, "utf8");
}
if (changed) {
  writeFileSync(serverPath, current, "utf8");
}

if (changed || aiChanged) {
  console.log("Patched Gemini AI assistant into WhatsApp incoming-message flow");
} else {
  console.log("Gemini AI assistant is already present in src/server.ts");
}
