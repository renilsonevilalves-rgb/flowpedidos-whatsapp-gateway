// tests/chat-order.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.GEMINI_API_KEY = "fake-test-gemini";
process.env.GEMINI_MODEL = "test-gemini";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "fake-test-backend-key";

const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const logger = { info() {}, warn() {} };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function params(id, text, messages) {
  return {
    sessionId: "22222222-2222-4222-8222-222222222222",
    customerJid: id + "@s.whatsapp.net",
    customerPhone: id,
    text, logger,
    sendMessage: async (_jid, item) => { messages.push(item.text); },
  };
}

test("collects items, asks for missing fields and commits only after explicit confirmation", async () => {
  const messages = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  const draft = { items: [{ productId: PRODUCT, quantity: 2, notes: "Sem cebola", selectedOptions: [] }],
    name: "", deliveryType: "", address: "", number: "", neighborhood: "", complement: "", reference: "", paymentMethod: "" };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const text = body.contents[0].parts[0].text;
      if (text.endsWith("retirada")) draft.deliveryType = "pickup";
      if (text.endsWith("Maria")) draft.name = "Maria";
      if (text.endsWith("Pix online")) draft.paymentMethod = "online_pix";
      return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({ draft }) }] } }] });
    }
    calls.push(body);
    if (body.action === "catalog") return response({
      ok: true, menuUrl: "https://menu.test", deliveryMode: "neighborhood",
      products: [{ id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] }],
    });
    if (body.action === "preview") return response({ ok: true, quoteToken: "signed.mock.token", expires: Date.now() + 60000,
      items: [{ name: "X Tudo", quantity: 2, total: 50, notes: "Sem cebola" }], subtotal: 50, deliveryFee: 0, total: 50 });
    if (body.action === "commit") return response({ ok: true, orderNumber: "5123", total: 50,
      message: "Aguardando pagamento online.", paymentUrl: "https://menu.test/pay/123" });
    throw new Error("unexpected request");
  };
  try {
    const id = "5531999988877";
    assert.equal(await handleChatOrderMessage(params(id, "quero 2 X Tudo sem cebola", messages)), true);
    assert.match(messages.at(-1), /entrega.*retirada/i);
    assert.equal(calls.filter((c) => c.action === "commit").length, 0);
    await handleChatOrderMessage(params(id, "retirada", messages));
    assert.match(messages.at(-1), /nome/i);
    await handleChatOrderMessage(params(id, "Maria", messages));
    assert.match(messages.at(-1), /pagar/i);
    await handleChatOrderMessage(params(id, "Pix online", messages));
    assert.match(messages.at(-1), /Confira seu pedido/i);
    assert.equal(calls.filter((c) => c.action === "commit").length, 0);
    assert.equal(calls.find((c) => c.action === "preview").items[0].notes, "Sem cebola");
    await handleChatOrderMessage(params(id, "SIM", messages));
    assert.equal(calls.filter((c) => c.action === "commit").length, 1);
    assert.match(messages.at(-1), /menu.test\/pay\/123/);
  } finally { globalThis.fetch = originalFetch; }
});

test("never intercepts existing-order changes or tracking", async () => {
  const messages = [];
  assert.equal(await handleChatOrderMessage(params("5531999966611", "quero alterar meu pedido", messages)), false);
  assert.equal(await handleChatOrderMessage(params("5531999966611", "acompanhar meu pedido", messages)), false);
  assert.equal(messages.length, 0);
});

test("feature respects backend deny-by-default and leaves legacy AI available", async () => {
  const messages = [];
  const old = globalThis.fetch;
  globalThis.fetch = async () => response({ ok: false, error: "Não habilitado." }, 403);
  try {
    assert.equal(await handleChatOrderMessage(params("5531999977711", "pedido pelo chat", messages)), false);
    assert.equal(messages.length, 0);
  } finally { globalThis.fetch = old; }
});


test("new-order checkout defers existing-order cancellation while the draft remains open", async () => {
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        draft: { items: [{ productId: PRODUCT, quantity: 1, notes: "", selectedOptions: [] }],
          name: "", deliveryType: "", address: "", number: "", neighborhood: "", complement: "", reference: "", paymentMethod: "" },
      }) }] } }] });
    }
    return response({ ok: true, menuUrl: "https://menu.test", deliveryMode: "neighborhood",
      products: [{ id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] }] });
  };
  try {
    const id = "5531999944433";
    assert.equal(await handleChatOrderMessage(params(id, "quero um X Tudo", sent)), true);
    assert.match(sent.at(-1), /entrega.*retirada/i);
    const before = sent.length;
    assert.equal(await handleChatOrderMessage(params(id, "quero cancelar meu pedido antigo", sent)), false);
    assert.equal(sent.length, before);
    assert.equal(await handleChatOrderMessage(params(id, "retirada", sent)), true);
    assert.match(sent.at(-1), /nome/i);
  } finally { globalThis.fetch = originalFetch; }
});
