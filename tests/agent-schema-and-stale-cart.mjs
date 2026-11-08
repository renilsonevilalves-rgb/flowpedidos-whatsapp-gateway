// 1) Every tool sent to Gemini must satisfy its schema rules (an invalid one
//    makes Google reject the WHOLE request with 400 and the AI goes silent).
// 2) Video 08/11: old cart (Coca, Pudim) + "adicionar mais 1 coxinha nesse
//    pedido que fiz agora" must change order #5611, never the old cart.
import test from "node:test";
import assert from "node:assert/strict";

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = SID;
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
// Writable temp folders (CI cannot write to /data).
{ const { tmpdir } = await import("node:os"); const base = tmpdir() + "/" + (await import("node:path")).basename(import.meta.url, ".mjs") + "-" + process.pid;
  process.env.CHAT_MEMORY_DIR = base + "-memory"; process.env.WHATSAPP_RECEIPT_DIR = base + "-receipts"; process.env.DATA_DIR = base + "-data"; }
process.env.API_KEY = "k";
const { declarations } = await import("../dist/chatCoordinator.js");
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");

const TYPES = new Set(["STRING", "INTEGER", "NUMBER", "BOOLEAN", "OBJECT", "ARRAY"]);
function check(schema, path, errors) {
  if (!TYPES.has(schema?.type)) errors.push(`${path}: tipo inválido ${schema?.type}`);
  if (schema.enum) {
    if (schema.type !== "STRING") errors.push(`${path}: enum só em STRING`);
    if (!Array.isArray(schema.enum) || !schema.enum.length) errors.push(`${path}: enum vazio`);
    for (const value of schema.enum || []) if (typeof value !== "string" || !value.trim()) errors.push(`${path}: valor de enum vazio`);
    if (new Set(schema.enum).size !== (schema.enum || []).length) errors.push(`${path}: enum repetido`);
  }
  if (schema.type === "OBJECT") {
    if (!schema.properties || typeof schema.properties !== "object") errors.push(`${path}: OBJECT sem properties`);
    for (const key of schema.required || []) if (!schema.properties?.[key]) errors.push(`${path}: required '${key}' não existe`);
    for (const [key, value] of Object.entries(schema.properties || {})) check(value, `${path}.${key}`, errors);
  }
  if (schema.type === "ARRAY") { if (!schema.items) errors.push(`${path}: ARRAY sem items`); else check(schema.items, `${path}[]`, errors); }
}

test("todas as ferramentas da IA respeitam as regras de schema do Gemini", () => {
  const errors = []; const names = new Set();
  for (const tool of declarations) {
    assert.match(tool.name, /^[a-z_][a-z0-9_]{0,63}$/);
    assert.ok(!names.has(tool.name), "ferramenta duplicada " + tool.name); names.add(tool.name);
    assert.ok(String(tool.description || "").trim(), "sem descrição: " + tool.name);
    check(tool.parameters, tool.name, errors);
  }
  assert.deepEqual(errors, []);
  for (const required of ["change_placed_order", "cancel_placed_order", "change_payment_method", "order_status", "call_human", "notify_store"])
    assert.ok(names.has(required), required);
});

const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const IDS = { coca: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1", pudim: "c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2", coxinha: "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3" };
const catalog = { ok: true, deliveryMode: "neighborhood", storeName: "Loja", menuUrl: "https://m", products: [
  { id: IDS.coca, name: "Coca cola 2L", price: 17.99, category: "Bebidas" },
  { id: IDS.pudim, name: "Pudim", price: 27.89, category: "Doces" },
  { id: IDS.coxinha, name: "Coxinha Catupiry", price: 9, category: "Salgados" }] };

test("vídeo: carrinho antigo + 'mais 1 coxinha nesse pedido que fiz agora' altera o pedido #5611 (mesmo com Gemini fora)", async () => {
  const phone = "5531975180001"; const jid = phone + "@s.whatsapp.net";
  const sent = []; let orderPlaced = false; let changeBody = null; let geminiDown = false;
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) {
      if (geminiDown) {
        // central agent schema rejected/unavailable; the simple interpreter (V2) still answers
        if (JSON.stringify(body).includes("functionDeclarations")) return res({ error: { message: "Invalid" } }, 400);
        return res({ candidates: [{ content: { parts: [{ text: JSON.stringify({ isOrderChange: true, action: "propose",
          plan: { operations: [{ action: "add_item", product: "Coxinha Catupiry", quantity: 1 }] }, reply: "" }) }] } }] });
      }
      return res({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "edit_cart",
        args: { operation: "add", productId: IDS.coca, quantity: 1 } } }] } }] });
    }
    if (u.includes("chat-order") && body.action === "catalog") return res(catalog);
    if (u.includes("order-self-service") && body.action === "lookup")
      return orderPlaced ? res({ ok: true, orders: [{ id: "o5611", orderNumber: "5611", statusLabel: "Em preparo", totalLabel: "R$ 12,00", createdAt: new Date().toISOString() }] })
        : res({ ok: false, code: "NO_ACTIONABLE_ORDER" }, 404);
    if (u.includes("order-self-service")) { changeBody = body;
      return res({ ok: true, operations: [{ action: "add_item", product: "Coxinha Catupiry", quantity: 1, unitPrice: 9, amount: 9 }], currentTotal: 12, proposedTotal: 21 }); }
    return res({ ok: true });
  };
  const send = (text) => handleChatOrderMessage({ sessionId: SID, customerJid: jid, customerPhone: phone, text, logger: { info() {}, warn() {}, error() {} },
    getStoreInfo: async () => ({ storeName: "Loja" }), sendMessage: async (_j, m) => { sent.push(m.text); } });
  await send("quero uma coca 2l");                      // old cart from an earlier test
  await new Promise((resolve) => setTimeout(resolve, 5));
  orderPlaced = true; geminiDown = true;                // customer then ordered on the digital menu
  sent.length = 0;
  await send("Quero adicionar apenas mais 1 coxinha nesse pedido que fiz agora");
  const out = sent.join("\n");
  assert.ok(changeBody, "deveria propor alteração do pedido feito. Respostas: " + out);
  assert.equal(changeBody.orderId, "o5611");
  assert.match(out, /#5611/);
  assert.doesNotMatch(out, /Coca|Pudim|Confira seu pedido/);
});
