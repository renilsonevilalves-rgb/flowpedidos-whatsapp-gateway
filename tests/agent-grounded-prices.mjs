// Print 08/11 15:13: "Tem Macarrão na chapaa?" -> the fallback model quoted a
// price without consulting the menu; the guard then replied a useless sentence
// over and over. Now: real prices pass, invented ones go to the catalog flow.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers-no-recent-order.mjs";

const SID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = SID;
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "k";
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const MAC = "f5f5f5f5-f5f5-45f5-85f5-f5f5f5f5f5f5";
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

function run(phone, text, modelReply) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) return res({ candidates: [{ content: { role: "model", parts: [{ text: modelReply }] } }] });
    if (u.includes("chat-order") && body.action === "catalog") return res({ ok: true, deliveryMode: "neighborhood", storeName: "Loja", menuUrl: "https://m",
      products: [{ id: MAC, name: "Macarrão na chapa", price: 32.5, category: "Pratos" }] });
    return res({ ok: true });
  };
  return handleChatOrderMessage({ sessionId: SID, customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text,
    logger: { info() {}, warn() {}, error() {} }, getStoreInfo: async () => ({ storeName: "Loja", aiContext: { delivery: { neighborhoods: [{ name: "Centro", fee: 5 }] } } }),
    sendMessage: async (_j, m) => { sent.push(m.text); } }).then(() => sent);
}

test("preço real do cardápio passa normalmente", async () => {
  const sent = await run("5531911119001", "Tem Macarrão na chapaa?", "Temos sim! O *Macarrão na chapa* sai por R$ 32,50. Quer que eu adicione?");
  assert.match(sent.join("\n"), /R\$ 32,50/);
});

test("2 unidades e taxa de entrega reais também passam", async () => {
  const sent = await run("5531911119002", "quanto fica 2 macarrão com entrega no centro?", "2x Macarrão na chapa ficam R$ 65,00 + taxa de R$ 5,00 no Centro.");
  assert.match(sent.join("\n"), /R\$ 65,00/);
});

test("preço inventado nunca é enviado e a resposta não é a frase vazia", async () => {
  const sent = await run("5531911119003", "Tem Macarrão na chapaa?", "Temos sim! Sai por R$ 25,00.");
  const out = sent.join("\n");
  assert.doesNotMatch(out, /R\$ 25,00/);
  assert.doesNotMatch(out, /Vou precisar consultar os valores/);
  assert.match(out, /Temos sim.*Macarrão na chapa/s, "mesmo com erro de digitação ('chapaa') o produto real é encontrado");
});
