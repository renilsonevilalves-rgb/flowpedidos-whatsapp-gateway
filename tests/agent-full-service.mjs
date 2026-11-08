import test from "node:test";
import assert from "node:assert/strict";
const SID = "66666666-6666-4666-8666-666666666666";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = "*";
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "k";
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { hasPendingOrderAction } = await import("../dist/aiAssistant.js");
const { isAiPaused, resetHumanHandoffForTests } = await import("../dist/humanHandoff.js");
process.env.HUMAN_HANDOFF_FILE = (await import("node:os")).tmpdir() + "/handoff-test-" + process.pid + ".json";
const logger = { info() {}, warn() {}, error() {} };
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const gem = (parts) => res({ candidates: [{ content: { role: "model", parts } }] });
const catalog = { ok: true, deliveryMode: "neighborhood", storeName: "Loja", menuUrl: "https://m",
  products: [{ id: "77777777-7777-4777-8777-777777777777", name: "Hot dog tradicional", price: 13.99, category: "Lanches" }] };
function run(phone, text, toolCall, backend) {
  const msgs = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) return gem([{ functionCall: toolCall }]);
    if (u.includes("chat-order")) return res(catalog);
    return backend(u, body);
  };
  return handleChatOrderMessage({ sessionId: SID, customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text, logger,
    getStoreInfo: async () => ({ storeName: "Loja" }), sendMessage: async (_j, m) => { msgs.push(m.text); } }).then((h) => ({ h, msgs }));
}

test("'não quero mais aquele lanche' (sem palavra 'cancelar') abre cancelamento com confirmação", async () => {
  const phone = "5531900000001";
  const { h, msgs } = await run(phone, "não quero mais aquele lanche, desisti", { name: "cancel_placed_order", args: {} }, (u, b) => {
    if (u.includes("order-self-service") && b.action === "lookup" && b.intent === "cancel")
      return res({ ok: true, orders: [{ id: "c1", orderNumber: "9001", status: "preparing", statusLabel: "Em preparo", total: 20, createdAt: new Date().toISOString() }] });
    if (u.includes("order-self-service")) return res({ ok: false, code: "NO_ACTIONABLE_ORDER" }, 404);
    return res({ ok: true });
  });
  assert.equal(h, true);
  assert.equal(msgs.length, 1, msgs.join("\n"));
  assert.match(msgs[0], /9001/);
  assert.match(msgs[0], /SIM/i);
  assert.equal(hasPendingOrderAction(SID, phone + "@s.whatsapp.net"), true);
  // A resposta "sim" fica com o fluxo de cancelamento, não com o carrinho.
  assert.equal(await handleChatOrderMessage({ sessionId: SID, customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text: "sim", logger, sendMessage: async () => {} }), false);
});

test("'cadê meu pedido' devolve o status oficial", async () => {
  const { msgs } = await run("5531900000002", "cadê meu pedido??", { name: "order_status", args: {} }, (u) => {
    if (u.includes("/order-status")) return res({ ok: true, message: "Seu pedido #9002 saiu para entrega 🛵" });
    return res({ ok: false }, 404);
  });
  assert.match(msgs.join("\n"), /9002 saiu para entrega/);
});

test("pedir atendente pausa a IA (salvo em disco) até o cliente pedir o robô de volta", async () => {
  resetHumanHandoffForTests();
  const phone = "5531900000003"; const jid = phone + "@s.whatsapp.net";
  const first = await run(phone, "quero falar com uma pessoa", { name: "call_human", args: { reason: "pediu" } }, () => res({ ok: false }, 404));
  assert.match(first.msgs[0], /equipe/i);
  assert.equal(await isAiPaused(SID, jid, "oi?"), true);
  const saved = JSON.parse(await (await import("node:fs/promises")).readFile(process.env.HUMAN_HANDOFF_FILE, "utf8"));
  assert.ok(Object.keys(saved).some((key) => key.includes(jid)));
  assert.equal(await isAiPaused(SID, jid, "quero voltar ao robô"), false);
  assert.equal(await isAiPaused(SID, jid, "oi"), false);
});
