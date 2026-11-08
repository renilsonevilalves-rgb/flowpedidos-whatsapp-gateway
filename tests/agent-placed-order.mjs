import test from "node:test";
import assert from "node:assert/strict";
const SID = "33333333-3333-4333-8333-333333333333";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = SID;
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "k";
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const logger = { info() {}, warn() {}, error() {} };
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const COCA = "44444444-4444-4444-8444-444444444444";
const HOT = "55555555-5555-4555-8555-555555555555";
const gem = (parts) => res({ candidates: [{ content: { role: "model", parts } }] });

test("IA central: 'quero adicionar uma coca 350' com pedido em produção altera o pedido feito", async () => {
  const msgs = []; let geminiCalls = 0; let sawRecent = false; let changeBody = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) {
      geminiCalls++;
      if (geminiCalls === 1) {
        sawRecent = JSON.stringify(body).includes("8324");
        return gem([{ functionCall: { name: "find_products", args: { search: "coca 350" } } }]);
      }
      return gem([{ functionCall: { name: "change_placed_order", args: { orderNumber: "8324", operations: [{ action: "add_item", product: "Coca Cola 350ml", quantity: 1 }] } } }]);
    }
    if (u.includes("order-self-service") && body.action === "lookup")
      return res({ ok: true, orders: [{ id: "o1", orderNumber: "8324", statusLabel: "Em preparo", totalLabel: "R$ 27,98" }] });
    if (u.includes("order-self-service")) { changeBody = body;
      return res({ ok: true, operations: [{ action: "add_item", product: "Coca Cola 350ml", quantity: 1, unitPrice: 6, amount: 6 }], currentTotal: 27.98, proposedTotal: 33.98 }); }
    if (u.includes("chat-order")) {
      if (body.action === "catalog") return res({ ok: true, deliveryMode: "neighborhood", storeName: "Loja", menuUrl: "https://m", products: [
        { id: COCA, name: "Coca Cola 350ml", price: 6, category: "Bebidas" },
        { id: HOT, name: "Hot dog tradicional", price: 13.99, category: "Lanches" }] });
      return res({ ok: true, draft: { items: [{ productId: COCA, quantity: 1 }] }, history: [] });
    }
    return res({ ok: true });
  };
  const handled = await handleChatOrderMessage({ sessionId: SID, customerJid: "5531975188031@s.whatsapp.net", customerPhone: "5531975188031",
    text: "Quero adicionar uma coca cola 350 ML", logger, getStoreInfo: async () => ({ storeName: "Loja" }),
    sendMessage: async (_j, m) => { msgs.push(m.text); } });
  assert.equal(handled, true);
  assert.ok(sawRecent, "IA precisa ver o pedido #8324");
  assert.equal(changeBody?.previewOnly, true);
  const out = msgs.join("\n");
  assert.match(out, /#8324/); assert.match(out, /Coca Cola 350ml/); assert.match(out, /SIM/);
  assert.doesNotMatch(out, /nome|retirada|carrinho/i);
});
