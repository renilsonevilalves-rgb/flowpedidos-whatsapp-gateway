// tests/chat-cart-removal.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.GEMINI_API_KEY = "fake-test-gemini";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "fake-test-backend-key";

const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { resolveCartAction } = await import("../dist/chatCartIntent.js");
const { mayBeCartAddition } = await import("../dist/chatDialogue.js");
const ID_VITAMINA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_PUDIM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const products = [
  { id: ID_VITAMINA, name: "Vitamina de Açaí", price: 14, optionGroups: [] },
  { id: ID_PUDIM, name: "Pudim", price: 9, optionGroups: [] },
];
const logger = { info() {}, warn() {} };
const response = (value, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { "Content-Type": "application/json" } });
function params(phone, text, messages) {
  return { sessionId: "22222222-2222-4222-8222-222222222222",
    customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text, logger,
    sendMessage: async (_jid, data) => { messages.push(data.text); } };
}
async function withCatalog(callback) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("generativelanguage.googleapis.com"))
      return response({ error: "unavailable" }, 503);
    const request = JSON.parse(opts.body);
    calls.push(request);
    if (request.action === "catalog")
      return response({ ok: true, menuUrl: "https://menu.test",
        deliveryMode: "neighborhood", products });
    if (request.action === "preview")
      return response({ ok: true, quoteToken: "mock.signed",
        expires: Date.now() + 60_000, items: [], subtotal: 0, total: 0, deliveryFee: 0 });
    throw new Error("unexpected backend action: " + request.action);
  };
  try { await callback(calls); }
  finally { globalThis.fetch = original; }
}

test("explicit cart removals have priority over 'por favor' and catalog questions", () => {
  const lines = [{ productId: ID_VITAMINA, quantity: 1 }, { productId: ID_PUDIM, quantity: 3 }];
  for (const text of ["Retire o pudim por favor", "Quero q tire o pudim",
    "Tira o pudim", "Remova o pudim por favor", "Não quero mais pudim"]) {
    assert.deepEqual(resolveCartAction(text, products, lines),
      { kind: "remove", productId: ID_PUDIM, quantity: null });
    assert.equal(mayBeCartAddition(text), false, text);
  }
  assert.deepEqual(resolveCartAction("Tira 2 pudins", products, lines),
    { kind: "remove", productId: ID_PUDIM, quantity: 2 });
  assert.deepEqual(resolveCartAction("Retirou o pudim?", products, lines),
    { kind: "status", productId: ID_PUDIM });
  assert.deepEqual(resolveCartAction("Quero sem cebola", products, lines), null);
  assert.equal(mayBeCartAddition("Por favor, me ajuda?"), false);
  assert.equal(mayBeCartAddition("Quero 1 pudim também"), true);
  assert.deepEqual(resolveCartAction("Não tire o pudim", products, lines), { kind: "keep" });
  assert.deepEqual(resolveCartAction("Não quero tirar o pudim", products, lines), { kind: "keep" });
  assert.deepEqual(resolveCartAction("Tem pudim no carrinho?", products, lines), { kind: "status", productId: ID_PUDIM });
  assert.deepEqual(resolveCartAction("Tira o pudim que tem no carrinho", products, lines),
    { kind: "remove", productId: ID_PUDIM, quantity: null });
  assert.deepEqual(resolveCartAction("E se eu tirar o pudim, quanto fica?", products, lines),
    { kind: "clarify", operation: "remove", choices: [] });
});

test("screenshot: remove pudim without adding it, then answer status and yes/no", async () => {
  await withCatalog(async (calls) => {
    const messages = [], phone = "5531999904411";
    await handleChatOrderMessage(params(phone, "Quero 1 Vitamina de Açaí e 3 Pudim", messages));
    assert.match(messages.at(-1), /3x Pudim/);
    assert.match(messages.at(-1), /1x Vitamina de Açaí/);
    await handleChatOrderMessage(params(phone, "Retire o pudim por favor", messages));
    assert.match(messages.at(-1), /Retirei.*Pudim/);
    assert.match(messages.at(-1), /1x Vitamina de Açaí/);
    assert.doesNotMatch(messages.at(-1), /4x Pudim|3x Pudim/);
    await handleChatOrderMessage(params(phone, "Retirou o pudim ?", messages));
    assert.match(messages.at(-1), /Sim, retirei.*Pudim/);
    await handleChatOrderMessage(params(phone, "Sim ou não?", messages));
    assert.match(messages.at(-1), /^Sim\..*Pudim/);
    assert.equal(calls.filter(call => call.action === "commit").length, 0);
  });
});

test("natural remove request does not reset the other cart items or checkout", async () => {
  await withCatalog(async (calls) => {
    const messages = [], phone = "5531999904412";
    await handleChatOrderMessage(params(phone, "Quero 1 Vitamina de Açaí e 3 Pudim", messages));
    assert.match(messages.at(-1), /3x Pudim/);
    await handleChatOrderMessage(params(phone, "Quero q tire o pudim", messages));
    assert.match(messages.at(-1), /Retirei.*Pudim/);
    assert.match(messages.at(-1), /1x Vitamina de Açaí/);
    await handleChatOrderMessage(params(phone, "Retirou o pudim?", messages));
    assert.match(messages.at(-1), /Sim, retirei/);
    assert.equal(calls.filter(call => call.action === "commit").length, 0);
  });
});

test("remove one of three items and verify status without a false yes", async () => {
  await withCatalog(async () => {
    const messages = [], phone = "5531999904413";
    await handleChatOrderMessage(params(phone, "Quero 3 Pudim", messages));
    assert.match(messages.at(-1), /3x Pudim/);
    await handleChatOrderMessage(params(phone, "Tira 1 pudim", messages));
    assert.match(messages.at(-1), /2x Pudim/);
    await handleChatOrderMessage(params(phone, "Retirou o pudim?", messages));
    assert.match(messages.at(-1), /^Não, .*2x/);
  });
});

test("unknown and multi-operation removal requests never mutate the cart by guesswork", () => {
  const cart = [{ productId: ID_VITAMINA, quantity: 1 }, { productId: ID_PUDIM, quantity: 3 }];
  assert.deepEqual(resolveCartAction("Tira o brownie", products, cart),
    { kind: "clarify", operation: "remove", choices: [] });
  assert.deepEqual(resolveCartAction("Tira o pudim e coloca um açaí", products, cart),
    { kind: "clarify", operation: "remove", choices: [] });
  assert.deepEqual(resolveCartAction("Sem cebola na vitamina", products, cart), null);
});
