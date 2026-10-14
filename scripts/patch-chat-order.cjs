// scripts/patch-chat-order.cjs
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const path = resolve(__dirname, "../src/server.ts");
let source = readFileSync(path, "utf8");
const marker = "import { handleAiAssistantMessage } from \"./aiAssistantV2.js\";";
const injected = marker + "\nimport { handleChatOrderMessage } from \"./chatOrder.js\";";
if (!source.includes(injected)) {
  if (!source.includes(marker)) throw new Error("Chat order routing: base AI assistant import was not patched");
  source = source.replace(marker, injected);
}
const receiptImport = 'import { flushPendingOrderReceipts } from "./chatReceiptOutbox.js";';
if (!source.includes(receiptImport)) {
  if (!source.includes(injected)) throw new Error("Receipt recovery: chat order import missing");
  source = source.replace(injected, injected + "\n" + receiptImport);
}
const anchor = "      const isTrigger = isAutoReplyTrigger(text);";
const hook = [
  "      // Chat checkout is opt-in; existing tracking, changes and menu greeting keep priority.",
  "      const chatCustomerJid = getCustomerJid(msg, remoteJid);",
  "      const chatCustomerPhone = await resolveCustomerPhone(sock, msg, remoteJid);",
  "      const chatHandled = await handleChatOrderMessage({",
  "        sessionId: id, customerJid: chatCustomerJid, customerPhone: chatCustomerPhone, text,",
  "        sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },",
  "        getStoreInfo: () => fetchStoreInfo(id, true),",
  "        logger,",
  "      });",
  "      if (chatHandled) continue;",
  "",
  anchor,
].join("\n");
if (!source.includes("const chatHandled = await handleChatOrderMessage")) {
  if (!source.includes(anchor)) throw new Error("Chat order routing: incoming message anchor not found");
  source = source.replace(anchor, hook);
}
// All earlier prebuild patches rely on the original fetchStoreInfo signature.
// Extend it only in the final chat-order patch, after privacy/session guards.
// Reconcile already-committed receipts after WhatsApp reconnect. Never issue a
// second commit on recovery; only lookup by existing tenant+phone+draftId key.
const connectionLog = '        logger.info({ sessionId: id, phone: session.phone }, "WhatsApp connected");';
const recoveryHook = connectionLog + [
  "",
  "        // Durable outbox replay after a Railway restart (non-blocking).",
  "        void flushPendingOrderReceipts(id, async (jid, text) => {",
  "          if (session.sock !== sock || session.status !== \"connected\") throw new Error(\"Session disconnected\");",
  "          await sock.sendMessage(jid, { text });",
  "        }, logger).catch(() => undefined);",
].join("\n");
if (!source.includes("void flushPendingOrderReceipts(id,")) {
  if (!source.includes(connectionLog)) throw new Error("Receipt recovery: socket connection hook not found");
  source = source.replace(connectionLog, recoveryHook);
}

const oldSignature = "async function fetchStoreInfo(sessionId: string) {";
const newSignature = "async function fetchStoreInfo(sessionId: string, includeAiContext = false) {";
if (source.includes(oldSignature)) source = source.replace(oldSignature, newSignature);
if (!source.includes(newSignature)) throw new Error("Chat order: fetchStoreInfo signature not found");
const startStoreInfo = source.indexOf(newSignature);
const endStoreInfo = source.indexOf("\n\nfunction unwrapMessage", startStoreInfo);
if (endStoreInfo < 0) throw new Error("Chat order: fetchStoreInfo ending not found");
let storeInfoBlock = source.slice(startStoreInfo, endStoreInfo);
const oldPayload = "body: JSON.stringify({ sessionId }),";
const newPayload = "body: JSON.stringify({ sessionId, includeAiContext }),";
if (storeInfoBlock.includes(oldPayload)) storeInfoBlock = storeInfoBlock.replace(oldPayload, newPayload);
if (!storeInfoBlock.includes(newPayload)) throw new Error("Chat order: store-info payload not found");
source = source.slice(0, startStoreInfo) + storeInfoBlock + source.slice(endStoreInfo);

writeFileSync(path, source, "utf8");
console.log("Gemini chat checkout handler integrated (disabled unless explicitly enabled).");
