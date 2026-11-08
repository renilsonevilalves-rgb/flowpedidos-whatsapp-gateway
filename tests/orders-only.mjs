// Modo padrão "orders": o WhatsApp NÃO tira pedido novo. Saudação e qualquer
// assunto fora de pedidos já feitos recebem o botão do cardápio digital; a IA
// só tem ferramentas de pedido já feito (status, cancelar, adicionar/remover
// item), dúvidas da loja e atendente.
import test from "node:test";
import assert from "node:assert/strict";
const SID = "abababab-abab-4bab-8bab-abababababab";
process.env.WHATSAPP_ATTENDANCE_MODE = "orders";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = "*";
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.GEMINI_FALLBACK_MODEL = "";
process.env.VERCEL_API_URL = "https://backend.test";
{ const { tmpdir } = await import("node:os"); const base = tmpdir() + "/orders-only-" + process.pid;
  process.env.CHAT_MEMORY_DIR = base + "-memory"; process.env.WHATSAPP_RECEIPT_DIR = base + "-receipts"; process.env.DATA_DIR = base + "-data";
  process.env.HUMAN_HANDOFF_FILE = base + "-handoff.json"; }
process.env.API_KEY = "k";
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { ORDERS_ONLY_TOOLS } = await import("../dist/chatCoordinator.js");

const logger = { info() {}, warn() {}, error() {} };
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const catalog = { ok: true, deliveryMode: "neighborhood", storeName: "Loja", menuUrl: "https://cardapio.test/loja",
  products: [{ id: "77777777-7777-4777-8777-777777777777", name: "Hot dog tradicional", price: 13.99, category: "Lanches" }] };

function run(phone, text, { gemini, backend = () => res({ ok: false }, 404), button = false } = {}) {
  const msgs = []; const geminiBodies = []; let buttons = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) { geminiBodies.push(body); return gemini ? gemini(body) : res({}, 500); }
    if (u.includes("chat-order")) return res(catalog);
    return backend(u, body);
  };
  return handleChatOrderMessage({ sessionId: SID, customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text, logger,
    getStoreInfo: async () => ({ storeName: "Loja" }),
    ...(button ? { sendMenuGreeting: async () => { buttons++; } } : {}),
    sendMessage: async (_j, m) => { msgs.push(m.text); } }).then((h) => ({ h, msgs, geminiBodies, buttons: () => buttons }));
}

test("'Oi' envia o botão do cardápio, sem chamar a IA", async () => {
  const r = await run("5531911110001", "Oi", { button: true });
  assert.equal(r.h, true);
  assert.equal(r.buttons(), 1);
  assert.equal(r.msgs.length, 0);
  assert.equal(r.geminiBodies.length, 0);
});

test("sem botão disponível, a saudação manda o link do cardápio em texto", async () => {
  const r = await run("5531911110002", "boa noite");
  assert.equal(r.h, true);
  assert.match(r.msgs.join("\n"), /Boa noite/);
  assert.match(r.msgs.join("\n"), /https:\/\/cardapio\.test\/loja/);
  assert.equal(r.geminiBodies.length, 0);
});

test("a IA só recebe ferramentas de pedido já feito, loja e atendente", async () => {
  const r = await run("5531911110003", "quero 2 hot dog", {
    gemini: () => res({ candidates: [{ content: { role: "model", parts: [{ text: "Os pedidos são feitos pelo cardápio digital: https://cardapio.test/loja 😊" }] } }] }),
  });
  assert.equal(r.h, true);
  const names = r.geminiBodies[0].tools[0].functionDeclarations.map((d) => d.name).sort();
  assert.deepEqual(names, [...ORDERS_ONLY_TOOLS].sort());
  for (const forbidden of ["edit_cart", "update_checkout", "preview_order", "read_cart", "change_payment_method"])
    assert.ok(!names.includes(forbidden), forbidden);
  assert.match(r.geminiBodies[0].system_instruction.parts[0].text, /MODO SOMENTE PEDIDOS JÁ FEITOS/);
  assert.match(r.msgs.join("\n"), /cardápio digital/);
});

test("se a IA tentar mexer no carrinho, a ferramenta é recusada e nada é anotado", async () => {
  let calls = 0;
  const r = await run("5531911110004", "me vê um hot dog tradicional", {
    gemini: () => {
      calls++;
      if (calls === 1) return res({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "edit_cart",
        args: { operation: "add", productId: catalog.products[0].id, quantity: 1 } } }] } }] });
      return res({ candidates: [{ content: { role: "model", parts: [{ text: "Para pedir, use o cardápio digital: https://cardapio.test/loja" }] } }] });
    },
  });
  const toolReply = JSON.stringify(r.geminiBodies[1]?.contents?.at(-1) || {});
  assert.match(toolReply, /Ferramenta indisponível/);
  assert.doesNotMatch(r.msgs.join("\n"), /adicionei|carrinho/i);
});

test("IA fora do ar e mensagem solta: responde com o cardápio, nunca fica mudo", async () => {
  const r = await run("5531911110005", "vcs tem estacionamento?", { button: true });
  assert.equal(r.h, true);
  assert.equal(r.buttons(), 1);
  assert.match(r.msgs.join("\n"), /cancelar ou alterar um pedido/);
});

test("nunca pergunta 'resumir a última alteração'", async () => {
  const loop = () => res({ candidates: [{ content: { role: "model", parts: [
    { functionCall: { name: "read_my_orders", args: {} } }, { functionCall: { name: "read_my_orders", args: {} } },
    { functionCall: { name: "read_my_orders", args: {} } }, { functionCall: { name: "read_my_orders", args: {} } },
  ] } }] });
  const r = await run("5531911110006", "não entendi", { gemini: loop,
    backend: (u) => u.includes("order-self-service") ? res({ ok: true, orders: [] }) : res({ ok: false }, 404) });
  assert.doesNotMatch(r.msgs.join("\n"), /resumir a última alteração/);
});

test("saudações compostas ('Olá boa tarde') também recebem o botão, sem IA", async () => {
  for (const [i, text] of ["Olá boa tarde", "oi, bom dia!", "Boa noite, tudo bem?", "oi pessoal tudo bem", "Ola tem alguem ai?"].entries()) {
    const r = await run("553191111" + String(1000 + i), text, { button: true });
    assert.equal(r.h, true, text);
    assert.equal(r.buttons(), 1, text);
    assert.equal(r.geminiBodies.length, 0, text);
  }
});

test("frases que não são só saudação continuam indo para a IA", async () => {
  const { classifyServiceIntent } = await import("../dist/chatOrder.js");
  for (const text of ["boa tarde, quero cancelar meu pedido", "oi cadê meu pedido", "olá, vocês abrem domingo?", "boa tarde queria tirar a batata do pedido"])
    assert.equal(classifyServiceIntent(text), null, text);
});
