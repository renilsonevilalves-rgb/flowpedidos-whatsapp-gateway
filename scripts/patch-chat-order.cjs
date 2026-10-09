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
const anchor = "      const isTrigger = isAutoReplyTrigger(text);";
const hook = [
  "      // Chat checkout is opt-in; existing tracking, changes and menu greeting keep priority.",
  "      const chatCustomerJid = getCustomerJid(msg, remoteJid);",
  "      const chatCustomerPhone = await resolveCustomerPhone(sock, msg, remoteJid);",
  "      const chatHandled = await handleChatOrderMessage({",
  "        sessionId: id, customerJid: chatCustomerJid, customerPhone: chatCustomerPhone, text,",
  "        sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },",
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
writeFileSync(path, source, "utf8");
console.log("Gemini chat checkout handler integrated (disabled unless explicitly enabled).");
