// Atendimento 100%: perfil do cliente, avisos à loja, atraso real, registro
// de conversas e pausa quando a loja responde manualmente pelo celular.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";

const SID = "88888888-8888-4888-8888-888888888888";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = SID;
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "k";
const { handleChatOrderMessage, usesCentralAgent } = await import("../dist/chatOrder.js");
const { logAiEvent, flushAiEvents, isProblemReply } = await import("../dist/aiEvents.js");
const logger = { info() {}, warn() {}, error() {} };
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const gem = (parts) => res({ candidates: [{ content: { role: "model", parts } }] });
const HOT = "99999999-9999-4999-8999-999999999999";

function harness({ gemini, backend = () => res({ ok: false }, 404), customer = null }) {
  const sent = [], events = [], prompts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) { prompts.push(JSON.stringify(body)); return gem(gemini(prompts.length, body)); }
    if (u.includes("chat-order") && body.action === "ai_event") { events.push(...body.events); return res({ ok: true }); }
    if (u.includes("chat-order") && body.action === "catalog") return res({ ok: true, deliveryMode: "neighborhood", storeName: "Loja", menuUrl: "https://m",
      products: [{ id: HOT, name: "Hot dog tradicional", price: 13.99, category: "Lanches" }], customer });
    return backend(u, body);
  };
  return { sent, events, prompts };
}
const msg = (phone, text, sent) => ({ sessionId: SID, customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text, logger,
  getStoreInfo: async () => ({ storeName: "Loja" }), sendMessage: async (_j, m) => { sent.push(m.text); } });

test("IA recebe o perfil do cliente (último pedido e endereço salvo) deste número", async () => {
  const h = harness({ gemini: () => [{ text: "Oi Renii! Quer repetir o Hot dog da última vez?" }],
    customer: { name: "Renii", lastOrder: { items: [{ productId: HOT, name: "Hot dog tradicional", quantity: 2, available: true }] },
      savedAddress: { address: "Tereza Cristina", number: "144", neighborhood: "Bernardo Monteiro" } } });
  await handleChatOrderMessage(msg("5531911110001", "boa noite, quero o mesmo de sempre", h.sent));
  assert.match(h.prompts[0], /customerProfile/);
  assert.match(h.prompts[0], /Tereza Cristina/);
  assert.match(h.sent.at(-1), /Renii/);
});

test("comprovante em foto: avisa a loja e nunca confirma o pagamento", async () => {
  const h = harness({ gemini: (n) => n === 1
    ? [{ functionCall: { name: "notify_store", args: { kind: "receipt", summary: "Pix de R$ 27,98 para Loja" } } }]
    : [{ text: "Recebi seu comprovante! A loja vai conferir o pagamento e já te confirma. 😊" }] });
  await handleChatOrderMessage(msg("5531911110002", "[Foto enviada pelo cliente: [COMPROVANTE] Pix de R$ 27,98 para Loja]", h.sent));
  await flushAiEvents();
  assert.ok(h.events.some((event) => event.kind === "receipt" && event.flagged === true), JSON.stringify(h.events));
  assert.match(h.sent.at(-1), /conferir/);
  assert.match(h.prompts[0], /NUNCA diga que o pagamento foi confirmado/);
});

test("atraso real: modelo recebe minutos e instrução, e a loja recebe alerta", async () => {
  let toolResponse = "";
  const h = harness({
    gemini: (n, body) => {
      if (n === 1) return [{ functionCall: { name: "order_status", args: {} } }];
      toolResponse = JSON.stringify(body.contents.at(-1));
      return [{ text: "Poxa, desculpa a demora! Seu pedido #8324 está em preparo há 52 minutos; já avisei a loja para priorizar." }];
    },
    backend: (u) => u.includes("/order-status")
      ? res({ ok: true, message: "pedido em produção", orderNumber: "8324", timing: { statusLabel: "em preparo", minutesSinceCreated: 52, estimateMaxMinutes: 20, late: true } })
      : res({ ok: false }, 404),
  });
  await handleChatOrderMessage(msg("5531911110003", "tá demorando demais, cadê??", h.sent));
  await flushAiEvents();
  assert.match(toolResponse, /ATRASADO/);
  assert.match(toolResponse, /52/);
  assert.ok(h.events.some((event) => event.kind === "delay"));
  assert.match(h.sent.at(-1), /52 minutos/);
});

test("registro: respostas problemáticas são marcadas e alertas saem na hora", async () => {
  assert.equal(isProblemReply("Pode me explicar um pouquinho mais?"), true);
  assert.equal(isProblemReply("Adicionei 1x Coca ao pedido"), false);
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return res({ ok: true }); };
  logAiEvent({ sessionId: SID, customerPhone: "5531911110004", kind: "human_request", role: "system", body: "pediu" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bodies.length, 1, "alerta não pode esperar o lote");
  assert.equal(bodies[0].action, "ai_event");
  logAiEvent({ sessionId: SID, customerPhone: "123", role: "customer", body: "telefone inválido é ignorado" });
  logAiEvent({ sessionId: SID, customerPhone: "5531911110004", role: "assistant", body: "Não entendi, pode repetir?" });
  await flushAiEvents();
  const events = bodies.flatMap((body) => body.events);
  assert.equal(events.filter((event) => event.customerPhone === "123").length, 0);
  assert.equal(events.find((event) => event.role === "assistant").flagged, true);
  assert.equal(usesCentralAgent(SID), true);
  assert.equal(usesCentralAgent("outra-loja"), false);
});

// --- Pausa quando a loja responde manualmente (código real do server.ts) ---
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(join(here, "../src/server.ts"), "utf8");
const parsed = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true);
const names = ["unwrapMessage", "extractMessageText", "getCustomerJid", "rememberOwnSend", "trackOwnSends", "hasRealContent", "handleStoreOwnMessage"];
const fns = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(fns.length, names.length);
const code = ts.transpileModule(fns.map((node) => node.getText(parsed)).join("\n") + "\nthis.api = { trackOwnSends, handleStoreOwnMessage, rememberOwnSend };",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function sandbox() {
  const pauses = [], logs = [];
  const context = {
    process: { env: {} }, setTimeout, console, Date,
    MANUAL_PAUSE_MINUTES: 30, ownSentIds: new Set(), lastCustomerMessageAt: new Map(), trackedSockets: new WeakSet(),
    pauseAi: async (...args) => { pauses.push(args); }, logAiEvent: (event) => logs.push(event),
    phoneForJid: (_s, jid) => jid.split("@")[0], takeTools: () => [], logger: { info() {} },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { api: context.api, ctx: context, pauses, logs };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const own = (id, text, jid = "5531922220000@s.whatsapp.net") => ({ key: { id, fromMe: true, remoteJid: jid }, message: { conversation: text } });

test("loja respondeu manualmente pelo celular: IA pausa 30 min para aquele cliente", async () => {
  const { api, pauses, logs } = sandbox();
  api.handleStoreOwnMessage(SID, own("MANUAL1", "Oi, aqui é o João da loja"));
  await wait(2700);
  assert.equal(pauses.length, 1);
  assert.deepEqual(pauses[0].slice(0, 4), [SID, "5531922220000@s.whatsapp.net", 30, "manual_reply"]);
  assert.equal(logs[0].kind, "manual_takeover");
  assert.equal(logs[0].role, "store");
});

test("mensagens enviadas pela própria IA/gateway nunca pausam a IA", async () => {
  const { api, pauses } = sandbox();
  const fakeSock = { sendMessage: async () => ({ key: { id: "BOT1" } }) };
  api.trackOwnSends(SID, fakeSock);
  await fakeSock.sendMessage("5531922220000@s.whatsapp.net", { text: "resposta da IA" });
  api.handleStoreOwnMessage(SID, own("BOT1", "resposta da IA"));
  await wait(2700);
  assert.equal(pauses.length, 0);
});

test("saudação automática do WhatsApp Business (segundos após o cliente) não pausa a IA", async () => {
  const { api, ctx, pauses } = sandbox();
  ctx.lastCustomerMessageAt.set(`${SID}:5531922220000@s.whatsapp.net`, Date.now());
  api.handleStoreOwnMessage(SID, own("AUTO1", "Olá! Obrigado pelo contato."));
  api.handleStoreOwnMessage(SID, { key: { id: "R1", fromMe: true, remoteJid: "5531922220000@s.whatsapp.net" }, message: { reactionMessage: { text: "👍" } } });
  api.handleStoreOwnMessage(SID, own("G1", "msg em grupo", "123@g.us"));
  await wait(2700);
  assert.equal(pauses.length, 0);
});
