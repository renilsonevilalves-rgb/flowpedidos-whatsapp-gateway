const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
const selfServicePath = resolve(__dirname, "../src/orderSelfService.ts");
let current = readFileSync(serverPath, "utf8");
let selfService = readFileSync(selfServicePath, "utf8");
let changed = false;
let selfServiceChanged = false;

function replaceOnce(original, replacement, label) {
  if (current.includes(replacement)) return;
  if (!current.includes(original)) {
    throw new Error(`Could not locate ${label} in src/server.ts`);
  }
  current = current.replace(original, replacement);
  changed = true;
}

function replaceSelfServiceOnce(original, replacement, label) {
  if (selfService.includes(replacement)) return;
  if (!selfService.includes(original)) {
    throw new Error(`Could not locate ${label} in src/orderSelfService.ts`);
  }
  selfService = selfService.replace(original, replacement);
  selfServiceChanged = true;
}

replaceSelfServiceOnce(
  `function setState(key: string, state: Omit<ConversationState, "expiresAt">) {`,
  `type ConversationStateInput<T> = T extends unknown ? Omit<T, "expiresAt"> : never;\n\nfunction setState(key: string, state: ConversationStateInput<ConversationState>) {`,
  "distributive conversation state input type",
);

replaceSelfServiceOnce(
  `  sendMessage: SendMessage;\n  logger: Logger;\n};`,
  `  sendMessage: SendMessage;\n  logger: Logger;\n  resolveCustomerPhone?: () => Promise<string | null>;\n};`,
  "LID phone resolver type",
);

replaceSelfServiceOnce(
  `  const customerJid = getCustomerJid(params.msg, params.remoteJid);\n  const phone = getPhoneFromJid(customerJid);\n  if (!customerJid || !phone) return false;`,
  `  const customerJid = getCustomerJid(params.msg, params.remoteJid);\n  const resolvedPhone = await params.resolveCustomerPhone?.();\n  const phone = resolvedPhone || (customerJid.endsWith("@s.whatsapp.net") ? getPhoneFromJid(customerJid) : "");\n  if (!customerJid) return false;\n  if (!phone) {\n    const key = stateKey(params.sessionId, customerJid);\n    const state = getState(key);\n    if (!state && !isCancelOrderTrigger(params.text) && !isChangeOrderTrigger(params.text)) return false;\n    clearState(key);\n    await params.sendMessage(customerJid, { text: "Não consegui identificar o número deste contato do WhatsApp agora. Tente novamente em instantes." });\n    params.logger.warn({ sessionId: params.sessionId, remoteJid: params.remoteJid }, "[Order-Self-Service] Could not resolve customer phone from WhatsApp LID");\n    return true;\n  }`,
  "LID-aware customer phone resolution",
);

replaceOnce(
  `} from "@whiskeysockets/baileys";\n\nconst PORT`,
  `} from "@whiskeysockets/baileys";\nimport { handleOrderSelfServiceMessage } from "./orderSelfService.js";\n\nconst PORT`,
  "order self-service import",
);

replaceOnce(
  `      logger.info({ sessionId: id, remoteJid, text }, "[Incoming] WhatsApp message received");\n\n      const isTrackingTrigger = isTrackOrderTrigger(text);`,
  `      logger.info({ sessionId: id, remoteJid, text }, "[Incoming] WhatsApp message received");\n\n      const selfServiceHandled = await handleOrderSelfServiceMessage({\n        sessionId: id,\n        msg,\n        remoteJid,\n        text,\n        vercelApiUrl: VERCEL_API_URL,\n        apiKey: API_KEY,\n        apiKey2: API_KEY_2,\n        sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },\n        resolveCustomerPhone: async () => resolveCustomerPhone(sock, msg, remoteJid),\n        logger,\n      });\n      if (selfServiceHandled) continue;\n\n      const isTrackingTrigger = isTrackOrderTrigger(text);`,
  "order self-service incoming-message hook",
);

if (selfServiceChanged) {
  writeFileSync(selfServicePath, selfService, "utf8");
}
if (changed) {
  writeFileSync(serverPath, current, "utf8");
}

if (changed || selfServiceChanged) {
  console.log("Patched WhatsApp customer order self-service flow");
} else {
  console.log("WhatsApp customer order self-service flow is already present in src/server.ts");
}
