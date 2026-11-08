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
const cancellationImports = 'import { isOrderCancellationRequest } from "./cancellationIntent.js";\nimport { hasPendingOrderCancellation } from "./aiAssistant.js";';
if (!source.includes(cancellationImports)) {
  if (!source.includes(injected)) throw new Error("Cancellation routing: chat handler import missing");
  source = source.replace(injected, injected + "\n" + cancellationImports);
}
const anchor = "      const isTrigger = isAutoReplyTrigger(text);";
const hook = [
  "      // Existing-order cancellation and its confirmation must precede the cart coordinator.",
  "      const chatCustomerJid = getCustomerJid(msg, remoteJid);",
  "      const chatCustomerPhone = await resolveCustomerPhone(sock, msg, remoteJid);",
  "      if (isOrderCancellationRequest(text) || hasPendingOrderCancellation(id, chatCustomerJid)) {",
  "        const cancellationHandled = await handleAiAssistantMessage({",
  "          sessionId: id, customerJid: chatCustomerJid, customerPhone: chatCustomerPhone, text,",
  "          getStoreInfo: () => fetchStoreInfo(id, true),",
  "          sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },",
  "          logger,",
  "        });",
  "        if (!cancellationHandled) await sock.sendMessage(chatCustomerJid, {",
  "          text: 'Não consegui consultar seu pedido para cancelamento agora. Tente novamente ou fale com a loja.',",
  "        });",
  "        continue;",
  "      }",
  "      // Chat checkout is opt-in; existing tracking, changes and menu greeting keep priority.",
  "      const chatHandled = await handleChatOrderMessage({",
  "        sessionId: id, customerJid: chatCustomerJid, customerPhone: chatCustomerPhone, text,",
  "        sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },",
  "        sendMenuGreeting: async () => {",
  "          const storeInfo = await fetchStoreInfo(id);",
  "          return sendMenuGreetingButton(sock, chatCustomerJid, storeInfo);",
  "        },",
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

// Recover committed-order receipts after a gateway restart/WhatsApp reconnect.
// The receipt outbox never retries payment or backend commit.
const outboxImport = 'import { drainOrderReceipts } from "./chatReceiptOutbox.js";';
if (!source.includes(outboxImport)) {
  const importAnchor = 'import { handleChatOrderMessage } from "./chatOrder.js";';
  if (!source.includes(importAnchor)) throw new Error("Receipt recovery: chat handler import missing");
  source = source.replace(importAnchor, importAnchor + "\n" + outboxImport);
}
const connectionAnchor = '        logger.info({ sessionId: id, phone: session.phone }, "WhatsApp connected");';
if (!source.includes("void drainOrderReceipts(id,")) {
  if (!source.includes(connectionAnchor)) throw new Error("Receipt recovery: WhatsApp connected hook missing");
  source = source.replace(connectionAnchor, connectionAnchor + "\n" +
    '        void drainOrderReceipts(id, async (jid, data) => { await sock.sendMessage(jid, data); }, logger)' +
    '.catch(() => logger.warn({ sessionId: id }, "[Chat-Receipt] Recovery scan failed"));');
}

writeFileSync(path, source, "utf8");
console.log("Gemini chat checkout handler integrated (disabled unless explicitly enabled).");
