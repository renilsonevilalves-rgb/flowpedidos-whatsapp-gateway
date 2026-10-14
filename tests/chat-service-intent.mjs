// tests/chat-service-intent.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = "22222222-2222-4222-8222-222222222222";
process.env.GEMINI_API_KEY = "unit-test-key";
process.env.GEMINI_MODEL = "unit-test-model";
process.env.GEMINI_AGENT_MODEL = "unit-test-model";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "unit-test-gateway-key";
process.env.WHATSAPP_RECEIPT_DIR = join(tmpdir(), "wa-service-intent-" + process.pid);

const { handleChatOrderMessage, classifyServiceIntent } = await import("../dist/chatOrder.js");
const tenant = "22222222-2222-4222-8222-222222222222";
const logger = { info() {}, warn() {} };
const catalog = { ok: true, storeName: "Loja Teste", menuUrl: "https://menu.test/cardapio/loja-teste",
  deliveryMode: "neighborhood", products: [
    { id: "11111111-1111-4111-8111-111111111111", name: "X Tudo", price: 25, optionGroups: [] },
  ] };
const ok = data => new Response(JSON.stringify(data), { status: 200,
  headers: { "Content-Type": "application/json" } });

test("customer phrasing matrix: menu, greetings, typos and deliberate non-menu cases", () => {
  const menus = [
    "cardapio", "cardápio", "CARDAPIO!!", "cardapio digital", "cardápio da loja",
    "cardpio", "cardapyo", "cardapioo", "menu", "catalogo",
    "quero o cardápio", "quero o cardápio digital", "me manda o cardapio",
    "envia o menu por favor", "me passa o link do cardápio", "gostaria de ver o cardápio",
    "pode enviar o cardapio?", "onde está o cardápio?", "bom dia, quero cardápio",
    "quero pedir pelo cardápio digital", "por favor me manda o cardápio",
  ];
  for (const phrasing of menus) assert.equal(classifyServiceIntent(phrasing), "menu", phrasing);
  for (const phrasing of ["oi", "olá", "bom dia", "boa tarde!", "boa noite", "opa", "tudo bem?"])
    assert.equal(classifyServiceIntent(phrasing), "greeting", phrasing);
  const others = [
    "quero pedir pelo chat sem cardápio", "não quero mais o cardápio", "sem cardápio, vou pedir por aqui",
    "quero saber o preço do X Tudo no cardápio", "quanto custa o pudim no cardápio?",
    "tem o X Tudo no cardápio?", "adiciona 2 X Tudo do cardápio", "quero tirar um pudim",
    "como está meu pedido?", "SIM", "retirada", "é para entregar na rua das flores",
  ];
  for (const phrasing of others) assert.equal(classifyServiceIntent(phrasing), null, phrasing);
});

test("explicit menu requests and greetings work when Gemini returns 429/503, without cart or checkout changes", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  const backendActions = [], sent = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      providerCalls++;
      return new Response("quota exceeded", { status: providerCalls % 2 ? 429 : 503 });
    }
    const request = JSON.parse(options.body);
    backendActions.push(request.action);
    if (request.action === "catalog") return ok(catalog);
    throw Error("Unexpected mutation or checkout: " + request.action);
  };
  const customer = "5531999951941";
  const params = text => ({
    sessionId: tenant, customerJid: customer + "@s.whatsapp.net",
    customerPhone: customer, text, logger,
    sendMessage: async (_jid, message) => { sent.push(message.text); },
  });
  try {
    for (const [phrase, responseStart] of [
      ["bom dia", "Bom dia!"], ["boa tarde", "Boa tarde!"],
      ["boa noite", "Boa noite!"], ["oi", "Olá!"],
    ]) {
      assert.equal(await handleChatOrderMessage(params(phrase)), true, phrase);
      assert.ok(sent.at(-1).startsWith(responseStart), phrase);
      assert.match(sent.at(-1), /https:\/\/menu\.test\/cardapio\/loja-teste/, phrase);
      assert.match(sent.at(-1), /também posso anotar seu pedido por aqui/i, phrase);
      assert.doesNotMatch(sent.at(-1), /posso te enviar o cardápio/i, phrase);
    }
    for (const phrase of ["cardapio", "quero o cardápio", "quero o cardápio digital",
      "me passa o link do cardápio", "cardpio", "cardápio digital"]) {
      assert.equal(await handleChatOrderMessage(params(phrase)), true, phrase);
      assert.match(sent.at(-1), /https:\/\/menu\.test\/cardapio\/loja-teste/, phrase);
      assert.doesNotMatch(sent.at(-1), /o que voc[eê] gostaria de pedir\?/i, phrase);
    }
    assert.equal(providerCalls, 0, "A menu request must never require a Gemini response");
    assert.ok(backendActions.every(action => action === "catalog"), "Do not modify or commit orders");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
