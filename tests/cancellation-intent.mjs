import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.GEMINI_API_KEY = "test-only-gemini-key";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "test-key";

const { isOrderCancellationRequest } = await import("../dist/cancellationIntent.js");
const { hasPendingOrderCancellation } = await import("../dist/aiAssistant.js");
const { handleAiAssistantMessage: handleAiV2 } = await import("../dist/aiAssistantV2.js");
const logger = { info() {}, warn() {}, error() {} };

const response = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

test("natural WhatsApp phrases request secure cancellation, even without an order number", () => {
  for (const phrase of [
    "Quero cancelar", "cancela", "CANCELAR!", "Cancelamento do pedido 4813",
    "Gostaria de cancelar meu pedido", "poderia cancelar meu pedido, pfv?",
    "Pode cancelar pra mim?", "Tem como cancelar?", "Me ajuda a cancelar",
    "Cancela tudo", "Cancela ai por favor", "Quero cancelar a compra",
    "Cancele o pedido #4813", "Cansela meu pedido", "kancela",
    "Desisti do pedido", "Não quero mais o pedido", "Não vou querer mais a compra",
    "Pode desfazer o pedido?", "Deixa pra lá o pedido", "Anula a compra",
    "Não quero mais", "Quero desistir", "Poderia fazer o cancelamento?",
  ]) {
    assert.equal(isOrderCancellationRequest(phrase), true, phrase);
  }
});

test("no cancellation lookup for questions, negations or individual cart items", () => {
  for (const phrase of [
    "Não quero cancelar", "Não cancela o pedido", "Pode cancelar não",
    "Como funciona o cancelamento?", "O que acontece se eu cancelar?",
    "Se eu cancelar meu pedido tenho multa?", "Cancelamento foi feito?",
    "Quero cancelar só uma coxinha", "Cancela apenas o item pudim",
    "Quero cancelar um produto", "Cancelar o pagamento", "Cancelar assinatura",
    "Cancelar a entrega", "Quero cancelar meu cadastro", "Cancela o cupom",
    "Desisti", "desistir", "deixa pra lá", "esquece", "tirar uma coca",
    "Quero retirar 1 item", "Quero trocar o pagamento", "Tem pastel?", "Boa noite",
  ]) {
    assert.equal(isOrderCancellationRequest(phrase), false, phrase);
  }
});

test("patched gateway prioritizes existing-order cancellation and SIM/NAO over cart and Gemini", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const cancellation = server.indexOf("const cancellationHandled = await handleAiAssistantMessage({");
  const cart = server.indexOf("const chatHandled = await handleChatOrderMessage({");
  const genericAi = server.indexOf("const aiHandled = await handleAiAssistantMessage({");
  assert.ok(cancellation > -1 && cancellation < cart, "cancel intents precede cart coordinator");
  assert.ok(cart < genericAi, "legacy conversational AI still runs after cart fallback");
  assert.match(server, /isOrderCancellationRequest\(text\) \|\| hasPendingOrderCancellation\(id, chatCustomerJid\)/);
  assert.match(server, /if \(!cancellationHandled\) await sock\.sendMessage/);
  const handoff = server.indexOf("const handled = await handleFatimaMessage({");
  assert.ok(handoff > -1 && handoff < cancellation, "Fatima's human handoff retains priority");
});

test("Click Testes regression: 'Quero cancelar' identifies active #4813 without Gemini or premature mutation", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  const actions = [];
  const order = { id: "bfe16223-4902-4cb9-a4cc-07136118bc8d", orderNumber: "4813", status: "preparing", statusLabel: "Em preparo" };
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith("/api/webhook/whatsapp/order-self-service"), "Gemini and cart must not intercept cancellation");
    const data = JSON.parse(options.body);
    actions.push(data);
    assert.equal(data.sessionId, "click-testes");
    assert.equal(data.phone, "5531999993252");
    if (data.action === "lookup") return response(200, { ok: true, orders: [order] });
    if (data.action === "cancel") {
      assert.equal(data.orderId, order.id);
      return response(200, { ok: true, message: "Pedido #4813 cancelado." });
    }
    throw Error("Unexpected order action");
  };
  const p = {
    sessionId: "click-testes", customerJid: "5531999993252@s.whatsapp.net", customerPhone: "5531999993252",
    getStoreInfo: async () => ({ capabilities: { ai_assistant: true }, storeName: "Click Testes" }),
    sendMessage: async (_jid, message) => { sent.push(message.text); },
    logger,
  };
  try {
    assert.equal(await handleAiV2({ ...p, text: "Quero cancelar" }), true);
    assert.deepEqual(actions.map(a => a.action), ["lookup"]);
    assert.match(sent.at(-1), /pedido #4813.*confirma o cancelamento.*SIM.*NÃO/i);
    assert.equal(hasPendingOrderCancellation(p.sessionId, p.customerJid), true);
    assert.equal(await handleAiV2({ ...p, text: "NÃO" }), true);
    assert.deepEqual(actions.map(a => a.action), ["lookup"]);
    assert.match(sent.at(-1), /não foi cancelado/i);
    assert.equal(hasPendingOrderCancellation(p.sessionId, p.customerJid), false);

    assert.equal(await handleAiV2({ ...p, text: "cancela ai por favor" }), true);
    assert.equal(actions.filter(a => a.action === "cancel").length, 0);
    assert.equal(await handleAiV2({ ...p, text: "sim" }), true);
    assert.deepEqual(actions.map(a => a.action), ["lookup", "lookup", "cancel"]);
    assert.match(sent.at(-1), /cancelado/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("screenshot 09:29: prioritize newly created #3570 instead of listing 25 stale test orders", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  const actions = [];
  const now = Date.now();
  const first = { id: "11111111-1111-4111-8111-111111111111", orderNumber: "3570", status: "preparing", statusLabel: "em preparo", totalLabel: "R$ 53,96", createdAt: new Date(now - 60_000).toISOString() };
  const older = { id: "22222222-2222-4222-8222-222222222222", orderNumber: "4813", status: "preparing", statusLabel: "em preparo", totalLabel: "R$ 29,00", createdAt: new Date(now - 8 * 60 * 60_000).toISOString() };
  const stale = Array.from({ length: 23 }, (_, index) => ({
    id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    orderNumber: String(6600 + index), status: "pending", statusLabel: "novo", totalLabel: "R$ 12,00",
    createdAt: new Date(now - (24 + index) * 60 * 60_000).toISOString(),
  }));
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith("/api/webhook/whatsapp/order-self-service"));
    const request = JSON.parse(options.body);
    actions.push(request.action);
    assert.equal(request.action, "lookup", "nothing is cancelled without a confirmed SIM");
    return response(200, { ok: true, orders: [first, older, ...stale] });
  };
  const base = {
    sessionId: "tenant-screenshot-newest", customerJid: "5531999955700@s.whatsapp.net", customerPhone: "5531999955700",
    getStoreInfo: async () => ({ capabilities: { ai_assistant: true } }),
    sendMessage: async (_jid, content) => { sent.push(content.text); }, logger,
  };
  try {
    assert.equal(await handleAiV2({ ...base, text: "Quero cancelar" }), true);
    assert.deepEqual(actions, ["lookup"]);
    assert.match(sent.at(-1), /pedido #3570.*R\$ 53,96.*confirma o cancelamento/i);
    assert.match(sent.at(-1), /OUTRO PEDIDO/);
    assert.doesNotMatch(sent.at(-1), /#4813|#6600/);

    assert.equal(await handleAiV2({ ...base, text: "Outro pedido" }), true);
    assert.match(sent.at(-1), /#4813/);
    assert.doesNotMatch(sent.at(-1), /\d+\. Pedido #3570|#6605/);
    assert.ok((sent.at(-1).match(/\d+\. Pedido/g) || []).length <= 5, "old orders are never dumped into WhatsApp");

    assert.equal(await handleAiV2({ ...base, text: "Pedido #4813" }), true);
    assert.match(sent.at(-1), /pedido #4813.*confirma o cancelamento/i);
    assert.equal(await handleAiV2({ ...base, text: "NÃO" }), true);
    assert.match(sent.at(-1), /não foi cancelado/i);
    assert.deepEqual(actions, ["lookup"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("screenshot 09:43: show only #8152, #3570 and #4813 from Em preparo; never 38 Novo orders", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  const calls = [];
  const now = Date.now();
  const preparing = [
    { id: "11111111-1111-4111-8111-111111111111", orderNumber: "8152", status: "preparing", statusLabel: "em preparo", totalLabel: "R$ 21,98", createdAt: new Date(now - 9 * 60_000).toISOString() },
    { id: "22222222-2222-4222-8222-222222222222", orderNumber: "3570", status: "preparing", statusLabel: "em preparo", totalLabel: "R$ 53,96", createdAt: new Date(now - 19 * 60_000).toISOString() },
    { id: "33333333-3333-4333-8333-333333333333", orderNumber: "4813", status: "preparing", statusLabel: "em preparo", totalLabel: "R$ 29,00", createdAt: new Date(now - 9 * 60 * 60_000).toISOString() },
  ];
  const oldPending = Array.from({ length: 38 }, (_, index) => ({
    id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
    orderNumber: String(6000 + index), status: "pending", statusLabel: "novo",
    createdAt: new Date(now - (10 + index) * 60_000).toISOString(),
  }));
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith("/api/webhook/whatsapp/order-self-service"));
    const body = JSON.parse(options.body);
    calls.push(body.action);
    assert.equal(body.action, "lookup", "cancellation requires a separate SIM confirmation");
    return response(200, { ok: true, orders: [...preparing, ...oldPending] });
  };
  const base = {
    sessionId: "tenant-screenshot-0943", customerJid: "5531999955815@s.whatsapp.net", customerPhone: "5531999955815",
    getStoreInfo: async () => ({ capabilities: { ai_assistant: true } }),
    sendMessage: async (_jid, content) => { sent.push(content.text); }, logger,
  };
  try {
    assert.equal(await handleAiV2({ ...base, text: "Quero cancelar" }), true);
    assert.match(sent.at(-1), /pedido #8152.*R\$ 21,98.*confirma o cancelamento/i);
    assert.doesNotMatch(sent.at(-1), /#3570|#4813|#6000/);
    assert.equal(await handleAiV2({ ...base, text: "OUTRO PEDIDO" }), true);
    assert.match(sent.at(-1), /#3570/);
    assert.match(sent.at(-1), /#4813/);
    assert.doesNotMatch(sent.at(-1), /#6000|#6001|#6002|novo/i);
    assert.equal(await handleAiV2({ ...base, text: "não" }), true);
    assert.match(sent.at(-1), /nenhuma alteração foi feita/i);
    assert.deepEqual(calls, ["lookup"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit order number chooses requested older order instead of the latest", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  const now = Date.now();
  const orders = [
    { id: "11111111-1111-4111-8111-111111111111", orderNumber: "3570", status: "preparing", createdAt: new Date(now - 60_000).toISOString() },
    { id: "22222222-2222-4222-8222-222222222222", orderNumber: "4813", status: "preparing", createdAt: new Date(now - 9 * 60 * 60_000).toISOString() },
  ];
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).action, "lookup");
    return response(200, { ok: true, orders });
  };
  const base = {
    sessionId: "tenant-explicit-number", customerJid: "5531999955701@s.whatsapp.net", customerPhone: "5531999955701",
    getStoreInfo: async () => ({ capabilities: { ai_assistant: true } }),
    sendMessage: async (_jid, content) => { sent.push(content.text); }, logger,
  };
  try {
    assert.equal(await handleAiV2({ ...base, text: "Cancela o pedido #4813" }), true);
    assert.match(sent.at(-1), /pedido #4813.*confirma o cancelamento/i);
    assert.doesNotMatch(sent.at(-1), /#3570/);
    assert.equal(await handleAiV2({ ...base, text: "NÃO" }), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("two similarly recent orders suggest the newest with explicit confirmation and OUTRO option", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  const now = Date.now();
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).action, "lookup");
    return response(200, { ok: true, orders: [
      { id: "11111111-1111-4111-8111-111111111111", orderNumber: "3570", status: "preparing", createdAt: new Date(now - 60_000).toISOString() },
      { id: "22222222-2222-4222-8222-222222222222", orderNumber: "4813", status: "preparing", createdAt: new Date(now - 3 * 60_000).toISOString() },
    ] });
  };
  const base = {
    sessionId: "tenant-two-recent", customerJid: "5531999955702@s.whatsapp.net", customerPhone: "5531999955702",
    getStoreInfo: async () => ({ capabilities: { ai_assistant: true } }),
    sendMessage: async (_jid, content) => { sent.push(content.text); }, logger,
  };
  try {
    assert.equal(await handleAiV2({ ...base, text: "Quero cancelar" }), true);
    assert.match(sent.at(-1), /pedido #3570.*confirma o cancelamento/i);
    assert.doesNotMatch(sent.at(-1), /#4813/);
    assert.equal(await handleAiV2({ ...base, text: "OUTRO PEDIDO" }), true);
    assert.match(sent.at(-1), /pedido #4813/i);
    assert.equal(await handleAiV2({ ...base, text: "Pedido #4813" }), true);
    assert.match(sent.at(-1), /pedido #4813.*confirma o cancelamento/i);
    assert.equal(await handleAiV2({ ...base, text: "não" }), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown explicit order number never silently falls back to a different order", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).action, "lookup");
    return response(200, { ok: true, orders: [{ id: "11111111-1111-4111-8111-111111111111", orderNumber: "3570", status: "preparing" }] });
  };
  const base = {
    sessionId: "tenant-missing-number", customerJid: "5531999955703@s.whatsapp.net", customerPhone: "5531999955703",
    getStoreInfo: async () => ({ capabilities: { ai_assistant: true } }),
    sendMessage: async (_jid, content) => { sent.push(content.text); }, logger,
  };
  try {
    assert.equal(await handleAiV2({ ...base, text: "Cancela o pedido 4813" }), true);
    assert.match(sent.at(-1), /não encontrei o pedido #4813/i);
    assert.doesNotMatch(sent.at(-1), /#3570/);
    assert.equal(hasPendingOrderCancellation(base.sessionId, base.customerJid), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("confirmation is bound to the same WhatsApp contact and denied plans cannot bypass entitlement", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests += 1;
    if (String(url).includes("generativelanguage.googleapis.com")) return response(503, {});
    if (JSON.parse(options.body).action === "lookup") return response(200, {
      ok: true, orders: [{ id: "11111111-1111-4111-8111-111111111111", orderNumber: "9021", status: "preparing" }],
    });
    throw Error("No cancellation was authorized");
  };
  const base = {
    sessionId: "tenant-closed", customerJid: "5511999991234@s.whatsapp.net", customerPhone: "5511999991234",
    getStoreInfo: async () => ({ capabilities: { ai_assistant: false } }),
    sendMessage: async (_jid, message) => { sent.push(message.text); }, logger,
  };
  try {
    assert.equal(await handleAiV2({ ...base, text: "cancela meu pedido" }), false);
    assert.equal(requests, 0, "plan restriction must prevent any lookup");
    const allowed = { ...base, sessionId: "tenant-enabled", getStoreInfo: async () => ({ capabilities: { ai_assistant: true } }) };
    assert.equal(await handleAiV2({ ...allowed, text: "quero cancelar" }), true);
    assert.equal(hasPendingOrderCancellation(allowed.sessionId, allowed.customerJid), true);
    assert.equal(hasPendingOrderCancellation(allowed.sessionId, "5511888888888@s.whatsapp.net"), false);
    assert.equal(hasPendingOrderCancellation(allowed.sessionId, allowed.customerJid), true);
    assert.equal(await handleAiV2({ ...allowed, text: "não" }), true);
    assert.match(sent.at(-1), /não foi cancelado/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
