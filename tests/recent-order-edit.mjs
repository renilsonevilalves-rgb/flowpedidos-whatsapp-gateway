import test from "node:test";
import assert from "node:assert/strict";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "k";
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { hasPendingOrderChange } = await import("../dist/aiAssistantV2.js");
const logger = { info() {}, warn() {}, error() {} };
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const SID = "22222222-2222-4222-8222-222222222222";
const p = (id, text, msgs) => ({ sessionId: SID, customerJid: id + "@s.whatsapp.net", customerPhone: id, text, logger,
  getStoreInfo: async () => ({ storeName: "Loja" }), sendMessage: async (_j, m) => { msgs.push(m.text); } });

test("'Quero adicionar uma coca 2l' após pedido em produção vira alteração do pedido, não carrinho novo", async () => {
  const msgs = [], paths = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); paths.push(u);
    if (u.includes("generativelanguage")) return res({ candidates: [{ content: { parts: [{ text: JSON.stringify({ isOrderChange: true, action: "propose", plan: { operations: [{ action: "add_item", product: "Coca Cola 2L", quantity: 1 }] }, reply: "" }) }] } }] });
    const body = JSON.parse(init.body);
    if (u.includes("order-self-service") && body.action === "lookup") return res({ ok: true, orders: [{ id: "a", orderNumber: "1376", total: 14.99 }] });
    if (u.includes("order-self-service")) return res({ ok: true, operations: [{ action: "add_item", product: "Coca Cola 2L", quantity: 1, unitPrice: 12, amount: 12 }], currentTotal: 14.99, proposedTotal: 26.99 });
    if (u.includes("chat-session")) return res({ ok: true });
    return res({ ok: false }, 404);
  };
  const handled = await handleChatOrderMessage(p("5531975188031", "Quero adicionar uma coca 2clitros", msgs));
  assert.equal(handled, true);
  assert.ok(paths.some(u => u.includes("order-self-service")));
  assert.ok(!msgs.join(" ").includes("carrinho"), msgs.join("\n"));
  assert.equal(hasPendingOrderChange(SID, "5531975188031@s.whatsapp.net"), true);
  // "sim" agora deve ser deixado para o fluxo de alteração (não para o carrinho).
  assert.equal(await handleChatOrderMessage(p("5531975188031", "sim", [])), false);
});

test("sem pedido alterável, 'adiciona uma coca' segue o fluxo normal", async () => {
  const msgs = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("order-self-service")) return res({ ok: false, code: "NO_ACTIONABLE_ORDER" }, 404);
    if (u.includes("generativelanguage")) throw new Error("não deveria chamar Gemini");
    return res({ ok: false }, 404);
  };
  await handleChatOrderMessage(p("5531999990000", "adiciona uma coca", msgs));
  assert.ok(!msgs.join(" ").includes("pedido #"));
});

test("referência explícita ao pedido já feito nunca é tratada como carrinho", async () => {
  globalThis.fetch = async () => res({ ok: false }, 404);
  assert.equal(await handleChatOrderMessage(p("5531999991111", "Coloca a coca nesse pedido que acabei de fazer", [])), false);
});
