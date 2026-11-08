// Print 08/11 15:04: after cancelling #5611, "Oi" / "Queria fazer um pedido por
// aqui" / "Queria fazer um novo pedido" kept showing an old cart (2x Coxinha).
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers-no-recent-order.mjs";

const SID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = SID;
process.env.WHATSAPP_CART_IDLE_RESET_MINUTES = "0";   // every cart counts as idle in this test
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "k";
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const COX = "e4e4e4e4-e4e4-44e4-84e4-e4e4e4e4e4e4";
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

async function scenario(phone, restartText) {
  const sent = []; const snapshots = []; let turn = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) {
      turn++;
      const text = JSON.stringify(body);
      snapshots.push(text);
      if (turn === 1) return res({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "edit_cart", args: { operation: "add", productId: COX, quantity: 2 } } }] } }] });
      return res({ candidates: [{ content: { role: "model", parts: [{ text: "Claro! O que você vai querer hoje? 😊" }] } }] });
    }
    if (u.includes("chat-order") && body.action === "catalog") return res({ ok: true, deliveryMode: "neighborhood", storeName: "Loja", menuUrl: "https://m",
      products: [{ id: COX, name: "Coxinha Catupiry", price: 9, category: "Salgados" }] });
    return res({ ok: true });
  };
  const send = (text) => handleChatOrderMessage({ sessionId: SID, customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text,
    logger: { info() {}, warn() {}, error() {} }, getStoreInfo: async () => ({ storeName: "Loja" }), sendMessage: async (_j, m) => { sent.push(m.text); } });
  await send("quero 2 coxinhas");
  await new Promise((resolve) => setTimeout(resolve, 5));
  sent.length = 0;
  await send(restartText);
  await send("o que tem no meu carrinho?");   // the AI must see an empty cart now
  const lastSnapshot = snapshots.at(-1);
  return { sent, lastSnapshot };
}

for (const text of ["Queria fazer um novo pedido", "Oi", "Queria fazer um pedido por aqui"]) {
  test(`'${text}' com carrinho antigo começa um pedido do zero`, async () => {
    const { sent, lastSnapshot } = await scenario("55319751800" + String(Math.floor(Math.random() * 90) + 10), text);
    assert.doesNotMatch(lastSnapshot, /"productId":"e4e4e4e4/, "a IA não pode receber o carrinho antigo");
    assert.doesNotMatch(sent.join("\n"), /Coxinha|Confira seu pedido|Para não repetir/);
  });
}
