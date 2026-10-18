// tests/chat-agent-audit.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = "22222222-2222-4222-8222-222222222222";
process.env.GEMINI_API_KEY = "test-only-key";
process.env.GEMINI_MODEL = "test-model";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "test-backend";
process.env.CHAT_MEMORY_DIR = join(tmpdir(), "chat-agent-audit-memory-" + process.pid);
process.env.WHATSAPP_RECEIPT_DIR = join(tmpdir(), "chat-agent-audit-receipts-" + process.pid);

const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { saveChatSession, loadChatSession } = await import("../dist/chatMemory.js");
const TENANT = "22222222-2222-4222-8222-222222222222";
const BOLO = "11111111-1111-4111-8111-111111111111";
const SANDUICHE = "33333333-3333-4333-8333-333333333333";
const PIZZA = "77777777-7777-4777-8777-777777777777";
const GRUPO = "44444444-4444-4444-8444-444444444444";
const GRUPO_PIZZA = "88888888-8888-4888-8888-888888888888";
const FRANGO = "55555555-5555-4555-8555-555555555555";
const PRESUNTO = "66666666-6666-4666-8666-666666666666";
const QUEIJO = "99999999-9999-4999-8999-999999999999";
const CALABRESA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const menu = { ok: true, storeName: "Padaria Fátima", menuUrl: "https://menu.test",
  deliveryMode: "neighborhood", neighborhoods: ["Centro"],
  products: [
    { id: BOLO, name: "Bolo Araponga", price: 9, optionGroups: [] },
    { id: SANDUICHE, name: "Sanduíche Natural", price: 15,
      optionGroups: [{ id: GRUPO, name: "Recheio", min: 1, max: 1,
        options: [{ id: FRANGO, name: "Frango", price: 0 }, { id: PRESUNTO, name: "Presunto", price: 0 }] }] },
    { id: PIZZA, name: "Pizza Meio a Meio", price: 30,
      optionGroups: [{ id: GRUPO_PIZZA, name: "Sabores", min: 2, max: 2,
        options: [{ id: QUEIJO, name: "Queijo", price: 0 },
          { id: CALABRESA, name: "Calabresa", price: 0 },
          { id: FRANGO, name: "Frango", price: 0 }] }] },
  ] };
const json = data => new Response(JSON.stringify(data),
  { headers: { "Content-Type": "application/json" } });
const logger = { warn() {}, info() {} };
const params = (phone, text, sent) => ({
  sessionId: TENANT, customerJid: phone + "@s.whatsapp.net", customerPhone: phone,
  text, logger, sendMessage: async (_jid, msg) => sent.push(msg.text),
});
const draft = items => ({ draftId: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1", items,
  name: "", deliveryType: "", address: "", number: "", neighborhood: "",
  complement: "", reference: "", paymentMethod: "" });
const mock = (modelMessage = "Preciso confirmar as opções do pedido.") => {
  const previous = globalThis.fetch;
  const counters = { model: 0, preview: 0, commit: 0 };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      counters.model++;
      return json({ candidates: [{ content: { role: "model", parts: [{ text: modelMessage }] } }] });
    }
    const request = JSON.parse(options.body);
    if (request.action === "catalog") return json(menu);
    if (request.action === "preview") { counters.preview++; throw Error("Unexpected preview"); }
    if (request.action === "commit") { counters.commit++; throw Error("Unexpected commit"); }
    throw Error("Unexpected backend action " + request.action);
  };
  return { counters, restore: () => { globalThis.fetch = previous; } };
};

test("pending mandatory options survive a new gateway module (restart) without mixing clients", async () => {
  const m = mock(), phone = "5531999963211", other = "5531999963212", sent = [];
  try {
    await handleChatOrderMessage(params(phone, "Oi", sent));
    await handleChatOrderMessage(params(phone, "Quero adicionar Sanduíche Natural", sent));
    let state = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(state.pendingProduct.productId, SANDUICHE);
    assert.equal(state.draft.items.length, 0);
    const { handleChatOrderMessage: afterRestart } = await import("../dist/chatOrder.js?audit-restart=1");
    await afterRestart(params(phone, "Frango", sent));
    state = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.deepEqual(state.draft.items.map(item => item.productId), [SANDUICHE]);
    assert.deepEqual(state.draft.items[0].selectedOptions,
      [{ groupId: GRUPO, id: FRANGO, quantity: 1 }]);
    const untouched = await loadChatSession(TENANT, other + "@s.whatsapp.net");
    assert.equal(untouched.draft, null);
    assert.equal(m.counters.commit, 0);
  } finally { m.restore(); }
});

test("SIM cannot quote or commit an old cart while new product options remain unanswered", async () => {
  const m = mock(), phone = "5531999963213", sent = [];
  try {
    await saveChatSession(TENANT, phone + "@s.whatsapp.net", [],
      draft([{ productId: BOLO, quantity: 1, selectedOptions: [] }]));
    await handleChatOrderMessage(params(phone, "Quero adicionar Sanduíche Natural", sent));
    assert.match(sent.at(-1), /Recheio/);
    await handleChatOrderMessage(params(phone, "SIM", sent));
    assert.match(sent.at(-1), /Recheio/);
    assert.equal(m.counters.preview, 0);
    assert.equal(m.counters.commit, 0);
    await handleChatOrderMessage(params(phone, "Não", sent));
    assert.match(sent.at(-1), /não adicionei.*Sanduíche Natural/i);
    const stored = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(stored.pendingProduct, null);
    assert.deepEqual(stored.draft.items.map(item => item.productId), [BOLO]);
  } finally { m.restore(); }
});

test("group with minimum 2 accepts successive distinct replies and never duplicates a selected option", async () => {
  const m = mock(), phone = "5531999963214", sent = [];
  try {
    await handleChatOrderMessage(params(phone, "Oi", sent));
    await handleChatOrderMessage(params(phone, "Quero adicionar Pizza Meio a Meio", sent));
    assert.match(sent.at(-1), /Sabores/);
    await handleChatOrderMessage(params(phone, "Queijo", sent));
    let stored = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(stored.draft.items.length, 0);
    assert.equal(stored.pendingProduct.selectedOptions.length, 1);
    await handleChatOrderMessage(params(phone, "Queijo", sent));
    assert.match(sent.at(-1), /já foi anotada/i);
    stored = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(stored.pendingProduct.selectedOptions.length, 1);
    await handleChatOrderMessage(params(phone, "Calabresa", sent));
    stored = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(stored.draft.items[0].productId, PIZZA);
    assert.deepEqual(stored.draft.items[0].selectedOptions.map(x => x.id).sort(), [QUEIJO, CALABRESA].sort());
    assert.equal(stored.pendingProduct, null);
    assert.equal(m.counters.commit, 0);
  } finally { m.restore(); }
});

test("model cannot claim it added a product when it never called a mutating tool", async () => {
  const m = mock("Pronto, adicionei 2 bolos ao seu pedido."), phone = "5531999963215", sent = [];
  try {
    await handleChatOrderMessage(params(phone, "Olá", sent));
    await handleChatOrderMessage(params(phone, "Pode escolher por mim?", sent));
    assert.doesNotMatch(sent.at(-1), /Pronto, adicionei/i);
    assert.match(sent.at(-1), /não fiz essa alteração/i);
    const state = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.equal(state.draft.items.length, 0);
    assert.equal(m.counters.commit, 0);
  } finally { m.restore(); }
});

test("explicit pending product abandonment never empties a prior cart", async () => {
  const m = mock(), phone = "5531999963216", sent = [];
  try {
    await saveChatSession(TENANT, phone + "@s.whatsapp.net", [],
      draft([{ productId: BOLO, quantity: 1, selectedOptions: [] }]));
    await handleChatOrderMessage(params(phone, "Quero adicionar Sanduíche Natural", sent));
    await handleChatOrderMessage(params(phone, "Deixa pra lá", sent));
    const state = await loadChatSession(TENANT, phone + "@s.whatsapp.net");
    assert.deepEqual(state.draft.items.map(item => item.productId), [BOLO]);
    assert.equal(state.pendingProduct, null);
    assert.match(sent.at(-1), /não adicionei/i);
  } finally { m.restore(); }
});
