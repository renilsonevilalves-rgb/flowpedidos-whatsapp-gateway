const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
let current = readFileSync(serverPath, "utf8");
let changed = false;

function replaceOnce(original, replacement, label) {
  if (current.includes(replacement)) return;
  if (!current.includes(original)) {
    throw new Error(`Could not locate ${label} in src/server.ts`);
  }
  current = current.replace(original, replacement);
  changed = true;
}

replaceOnce(
  `import { handleOrderSelfServiceMessage } from "./orderSelfService.js";\n\nconst PORT`,
  `import { handleOrderSelfServiceMessage } from "./orderSelfService.js";\nimport { handleAiAssistantMessage } from "./aiAssistant.js";\n\nconst PORT`,
  "AI assistant import",
);

replaceOnce(
  `      const isTrigger = isAutoReplyTrigger(text);`,
  `      const aiCustomerJid = getCustomerJid(msg, remoteJid);\n      const aiHandled = await handleAiAssistantMessage({\n        sessionId: id,\n        customerJid: aiCustomerJid,\n        text,\n        getStoreInfo: async () => fetchStoreInfo(id),\n        sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },\n        logger,\n      });\n      if (aiHandled) continue;\n\n      const isTrigger = isAutoReplyTrigger(text);`,
  "AI assistant incoming-message hook",
);

if (changed) {
  writeFileSync(serverPath, current, "utf8");
  console.log("Patched Gemini AI assistant into WhatsApp incoming-message flow");
} else {
  console.log("Gemini AI assistant is already present in src/server.ts");
}
