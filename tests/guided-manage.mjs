// Menu 4 (alterar/cancelar) no modo guiado: adicionar item em pedido já feito
// e iniciar cancelamento — sempre com confirmação SIM/NÃO, sem IA.
import test from "node:test";
import assert from "node:assert/strict";

const SID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = SID;
process.env.WHATSAPP_ATTENDANCE_MODE = "guided";
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
// Writable temp folders (CI cannot write to /data).
{ const { tmpdir } = await import("node:os"); const base = tmpdir() + "/" + (await import("node:path")).basename(import.meta.url, ".mjs") + "-" + process.pid;
  process.env.CHAT_MEMORY_DIR = base + "-memory"; process.env.WHATSAPP_RECEIPT_DIR = base + "-receipts"; process.env.DATA_DIR = base + "-data"; }
process.env.API_KEY = "k";
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const COX = "22222222-bbbb-4bbb-8bbb-000000000001";
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

function harness() {
  const sent = []; const calls = { gemini: 0, change: null };
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) { calls.gemini++; return res({}, 500); }
    if (u.includes("chat-order")) return res({ ok: true, storeName: "Loja", menuUrl: "https://m", deliveryMode: "neighborhood",
      products: [{ id: COX, name: "Coxinha Catupiry", price: 9, category: "Salgados" }] });
    if (u.includes("order-self-service") && body.action === "lookup")
      return res({ ok: true, orders: [{ id: "o77", orderNumber: "7700", status: "preparing", statusLabel: "Em preparo", total: 20, totalLabel: "R$ 20,00", createdAt: new Date().toISOString() }] });
    if (u.includes("order-self-service") && body.action === "change") {
      calls.change = body;
      return res({ ok: true, operations: [{ action: "add_item", product: "Coxinha Catupiry", quantity: 2, unitPrice: 9, amount: 18 }], currentTotal: 20, proposedTotal: 38 });
    }
    return res({ ok: true });
  };
  const phone = "55319" + String(10000000 + Math.floor(Math.random() * 8999999));
  const say = async (text) => {
    sent.length = 0;
    await handleChatOrderMessage({ sessionId: SID, customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text,
      logger: { info() {}, warn() {}, error() {} }, getStoreInfo: async () => ({ storeName: "Loja" }),
      sendMessage: async (_j, m) => { sent.push(m.text); } });
    return sent.join("\n");
  };
  return { say, calls };
}

test("menu 4 → 1: adicionar 2 coxinhas no pedido #7700 com confirmação", async () => {
  const { say, calls } = harness();
  await say("opções");
  let out = await say("4");  assert.match(out, /Adicionar item em um pedido já feito/);
  out = await say("1");      assert.match(out, /adicionar ao pedido #7700/);
  out = await say("1");      assert.match(out, /Quantas unidades/);
  out = await say("2");
  assert.equal(calls.change.orderId, "o77");
  assert.equal(calls.change.previewOnly, true);
  assert.deepEqual(calls.change.changePlan.operations[0], { action: "add_item", product: "Coxinha Catupiry", quantity: 2 });
  assert.match(out, /#7700/); assert.match(out, /SIM/);
  assert.equal(calls.gemini, 0);
});

test("menu 4 → 2: cancelamento pede confirmação", async () => {
  const { say, calls } = harness();
  await say("opções"); await say("4");
  const out = await say("2");
  assert.match(out, /7700/); assert.match(out, /SIM/i);
  assert.equal(calls.gemini, 0);
});
