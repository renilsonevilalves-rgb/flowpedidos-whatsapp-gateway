// tests/chat-product-interruption.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = "22222222-2222-4222-8222-222222222222";
process.env.GEMINI_API_KEY = "test-only-key";
process.env.GEMINI_MODEL = "test-model";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "test-backend";
process.env.WHATSAPP_RECEIPT_DIR = join(tmpdir(), "wa-product-interruption-" + process.pid);
process.env.CHAT_MEMORY_DIR = join(tmpdir(), "wa-product-interruption-memory-" + process.pid);

const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { loadChatSession } = await import("../dist/chatMemory.js");

const TENANT = "22222222-2222-4222-8222-222222222222";
const BOLO = "11111111-1111-4111-8111-111111111111";
const SANDUICHE = "33333333-3333-4333-8333-333333333333";
const GRUPO = "44444444-4444-4444-8444-444444444444";
const FRANGO = "55555555-5555-4555-8555-555555555555";
const PRESUNTO = "66666666-6666-4666-8666-666666666666";

const catalog = {
  ok: true, storeName: "Padaria Fátima", menuUrl: "https://menu.test",
  deliveryMode: "neighborhood", neighborhoods: ["Centro"],
  products: [
    { id: SANDUICHE, name: "Sanduíche Natural", price: 15,
      optionGroups: [{ id: GRUPO, name: "Recheio", min: 1, max: 1,
        options: [{ id: FRANGO, name: "Frango", price: 0 },
          { id: PRESUNTO, name: "Presunto", price: 0 }] }] },
    { id: BOLO, name: "Bolo Araponga", price: 9, optionGroups: [] },
  ],
};
const response = (body) => new Response(JSON.stringify(body),
  { status: 200, headers: { "Content-Type": "application/json" } });
const logger = { warn() {}, info() {} };
const makeParams = (phone, text, sent) => ({
  sessionId: TENANT, customerJid: phone + "@s.whatsapp.net",
  customerPhone: phone, text, logger,
  sendMessage: async (_jid, payload) => { sent.push(payload.text); },
});
function mockBackendAndModel() {
  const original = globalThis.fetch;
  const counters = { gemini: 0, catalog: 0, previews: 0, commits: 0 };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      counters.gemini++;
      return response({ candidates: [{ content: { role: "model", parts: [
        { text: '"Sanduíche Natural" possui opções obrigatórias. Para evitar montar o item incorretamente, faça esse item pelo cardápio ou fale com a loja.\n\nPode me explicar como você quer deixar o pedido?' },
      ] } }] });
    }
    const request = JSON.parse(options.body);
    if (request.action === "catalog") { counters.catalog++; return response(catalog); }
    if (request.action === "preview") { counters.previews++; throw Error("Preview must not be needed here"); }
    if (request.action === "commit") { counters.commits++; throw Error("Commit must not be called"); }
    throw Error("Unexpected action: " + request.action);
  };
  return { counters, restore: () => { globalThis.fetch = original; } };
}

test("new Bolo Araponga request escapes the Sanduíche Natural loop without inventing mandatory options", async () => {
  const sent = [], phone = "5531999981101";
  const mock = mockBackendAndModel();
  try {
    assert.equal(await handleChatOrderMessage(makeParams(phone, "Quero 1 Sanduíche Natural", sent)), true);
    assert.match(sent.at(-1), /possui opções obrigatórias/);
    const before = mock.counters.gemini;
    assert.equal(await handleChatOrderMessage(makeParams(phone, "Quero adicionar bolo araponga", sent)), true);
    assert.match(sent.at(-1), /Adicionei.*Bolo Araponga/i);
    assert.doesNotMatch(sent.at(-1), /Sanduíche Natural.*possui opções obrigatórias/);
    assert.equal(mock.counters.gemini, before, "no model retry on explicit catalog addition");
    const persisted = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.deepEqual(persisted.draft.items.map(item => item.productId), [BOLO]);
    assert.equal(mock.counters.commits, 0);
  } finally { mock.restore(); }
});

test("mandatory options of a new product are asked by name and validated before adding", async () => {
  const sent = [], phone = "5531999981102";
  const mock = mockBackendAndModel();
  try {
    await handleChatOrderMessage(makeParams(phone, "Oi", sent));
    await handleChatOrderMessage(makeParams(phone, "Quero adicionar sanduíche natural", sent));
    assert.match(sent.at(-1), /Recheio.*Frango.*Presunto/i);
    let persisted = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(persisted.draft.items.length, 0, "do not add incomplete customizations");
    await handleChatOrderMessage(makeParams(phone, "Frango", sent));
    assert.match(sent.at(-1), /Adicionei.*Sanduíche Natural/i);
    persisted = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(persisted.draft.items[0].productId, SANDUICHE);
    assert.deepEqual(persisted.draft.items[0].selectedOptions,
      [{ groupId: GRUPO, id: FRANGO, quantity: 1 }]);
    assert.equal(mock.counters.commits, 0);
  } finally { mock.restore(); }
});

test("explicit negation or a combined swap is not misread as a standalone addition", async () => {
  const sent = [], phone = "5531999981103";
  const mock = mockBackendAndModel();
  try {
    await handleChatOrderMessage(makeParams(phone, "Oi", sent));
    await handleChatOrderMessage(makeParams(phone, "Não quero adicionar Bolo Araponga", sent));
    assert.doesNotMatch(sent.at(-1), /Adicionei.*Bolo Araponga/i);
    await handleChatOrderMessage(makeParams(phone, "Quero adicionar Bolo Araponga e trocar Sanduíche Natural", sent));
    assert.doesNotMatch(sent.at(-1), /Adicionei.*Bolo Araponga/i);
    const persisted = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(persisted.draft.items.length, 0);
    assert.equal(mock.counters.commits, 0);
  } finally { mock.restore(); }
});
