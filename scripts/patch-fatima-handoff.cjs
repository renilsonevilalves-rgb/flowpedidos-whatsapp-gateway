const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const path = resolve(__dirname, "../src/server.ts");
let source = readFileSync(path, "utf8");
const importAnchor = 'import { handleChatOrderMessage } from "./chatOrder.js";';
const importLine = 'import { extractFatimaChoice, FATIMA_TENANT_ID, handleFatimaMessage } from "./fatimaHandoff.js";';
if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error("Fatima handoff: chat order import not found");
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const oldMessageCheck = '      if (!text) continue;';
const newMessageCheck = '      if (!text && !(id === FATIMA_TENANT_ID && extractFatimaChoice(msg.message))) continue;';
if (!source.includes(newMessageCheck)) {
  if (!source.includes(oldMessageCheck)) throw new Error("Fatima handoff: incoming message check not found");
  source = source.replace(oldMessageCheck, newMessageCheck);
}

const anchor = '      const isTrackingTrigger = isTrackOrderTrigger(text);';
const hook = `      // The Fatima opt-in menu precedes conversational AI; transactional outbound messages use /send.
      if (id === FATIMA_TENANT_ID) {
        const customerJid = getCustomerJid(msg, remoteJid);
        const handled = await handleFatimaMessage({
          sessionId: id, customerJid, text, rawMessage: msg.message, logger,
          sendGreeting: async () => {
            const storeInfo = await fetchStoreInfo(id);
            if (!storeInfo?.menuUrl) throw new Error("Fatima has no configured menu URL");
            await sendMenuGreetingButton(sock, customerJid, storeInfo, true);
            await sock.sendMessage(customerJid, {
              text: "💬 *Prefere conversar com a loja?*\\nResponda *2* para falar com um atendente da Padaria Fátima.",
            });
          },
          sendMessage: async (reply) => { await sock.sendMessage(customerJid, { text: reply }); },
        });
        if (handled) continue;
      }

${anchor}`;
if (!source.includes('const handled = await handleFatimaMessage')) {
  if (!source.includes(anchor)) throw new Error("Fatima handoff: incoming routing anchor not found");
  source = source.replace(anchor, hook);
}

if (!source.includes(importLine) || !source.includes('const handled = await handleFatimaMessage')) {
  throw new Error("Fatima handoff: integration was not applied");
}
writeFileSync(path, source, "utf8");
console.log("Fatima-only human handoff integrated (6-hour inactivity)");
