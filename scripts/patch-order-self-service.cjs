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
  `} from "@whiskeysockets/baileys";\n\nconst PORT`,
  `} from "@whiskeysockets/baileys";\nimport { handleOrderSelfServiceMessage } from "./orderSelfService.js";\n\nconst PORT`,
  "order self-service import",
);

replaceOnce(
  `      logger.info({ sessionId: id, remoteJid, text }, "[Incoming] WhatsApp message received");\n\n      const isTrackingTrigger = isTrackOrderTrigger(text);`,
  `      logger.info({ sessionId: id, remoteJid, text }, "[Incoming] WhatsApp message received");\n\n      const selfServiceHandled = await handleOrderSelfServiceMessage({\n        sessionId: id,\n        msg,\n        remoteJid,\n        text,\n        vercelApiUrl: VERCEL_API_URL,\n        apiKey: API_KEY,\n        apiKey2: API_KEY_2,\n        sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },\n        logger,\n      });\n      if (selfServiceHandled) continue;\n\n      const isTrackingTrigger = isTrackOrderTrigger(text);`,
  "order self-service incoming-message hook",
);

if (changed) {
  writeFileSync(serverPath, current, "utf8");
  console.log("Patched WhatsApp customer order self-service flow");
} else {
  console.log("WhatsApp customer order self-service flow is already present in src/server.ts");
}
