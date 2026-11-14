// Conexão "zumbi" (conectada, mas sem receber mensagens) e mensagens recebidas durante quedas.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { watchConnectionHealth, stallRecoveryDelayMs } = await import("../dist/connectionHealth.js");
const { selectOfflineCustomerMessages } = await import("../dist/offlineMessages.js");

function harness(config = {}) {
  let clock = 1_000_000;
  let tick;
  const sent = [];
  const stalls = [];
  const logs = [];
  const sock = { ev: new EventEmitter(), ws: new EventEmitter(), sendNode: async (node) => { sent.push(node); } };
  const logger = { info: (_d, m) => logs.push(m), warn: (_d, m) => logs.push(m) };
  const stop = watchConnectionHealth({
    sessionId: "loja", sock, logger,
    onStall: (reason, details) => stalls.push({ reason, details }),
    now: () => clock,
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval: () => { tick = undefined; },
    config: { tickMs: 5_000, offlineIdleMs: 4_000, offlineNudgeAfterMs: 20_000, offlineSyncDeadlineMs: 180_000, inboundStallMs: 120_000, ...config },
  });
  return {
    sock, sent, stalls, logs, stop,
    advance(ms) { const end = clock + ms; while (clock < end) { clock = Math.min(end, clock + 5_000); tick?.(); } },
    open() { sock.ev.emit("connection.update", { connection: "open" }); },
    offlineNode(tag = "message") { sock.ws.emit(`CB:${tag}`, { tag, attrs: { offline: "1", from: "5511@s.whatsapp.net", id: String(Math.random()) } }); },
    liveMessage(id, from = "5511@s.whatsapp.net") { sock.ws.emit("CB:message", { tag: "message", attrs: { id, from } }); },
    processed(id, type = "notify") { sock.ev.emit("messages.upsert", { type, messages: [{ key: { id } }] }); },
    get watching() { return Boolean(tick); },
  };
}

const batchRequests = (sent) => sent.filter((node) => node.content?.[0]?.tag === "offline_batch").length;

test("acúmulo maior que um lote: pede o próximo lote quando o anterior para de chegar", async () => {
  const h = harness();
  h.open();
  h.sock.ws.emit("CB:ib,,offline_preview", { tag: "ib" });
  for (let i = 0; i < 100; i += 1) h.offlineNode(i % 2 ? "receipt" : "message");
  h.advance(2_000);
  await Promise.resolve();
  assert.equal(batchRequests(h.sent), 0, "não pede enquanto o lote ainda está chegando");
  h.advance(5_000);
  await Promise.resolve();
  assert.equal(batchRequests(h.sent), 1);
  assert.equal(h.sent[0].content[0].attrs.count, "100");
  h.sock.ws.emit("CB:ib,,offline", { tag: "ib" });
  h.advance(300_000);
  assert.equal(h.stalls.length, 0, "sincronizou: não reconecta");
  assert.ok(h.logs.some((m) => m.includes("Pendências sincronizadas")));
});

test("sincronização que nunca termina reconecta a loja no prazo, uma única vez", () => {
  const h = harness();
  h.open();
  h.advance(179_000);
  assert.equal(h.stalls.length, 0);
  h.advance(5_000);
  assert.equal(h.stalls.length, 1);
  assert.equal(h.stalls[0].reason, "offline_sync_stuck");
  assert.ok(h.stalls[0].details.batchRequests > 0, "tentou destravar pedindo lotes antes de reconectar");
  h.advance(600_000);
  assert.equal(h.stalls.length, 1);
  assert.equal(h.watching, false);
});

test("loja sem movimento nunca é reconectada à toa", () => {
  const h = harness();
  h.open();
  h.sock.ev.emit("connection.update", { receivedPendingNotifications: true });
  h.advance(6 * 60 * 60_000);
  assert.equal(h.stalls.length, 0);
  assert.equal(batchRequests(h.sent), 0);
});

test("mensagem em tempo real processada prova que a conexão está viva", () => {
  const h = harness();
  h.open();
  h.liveMessage("A");
  h.processed("A", "notify");
  h.advance(600_000);
  assert.equal(h.stalls.length, 0);
});

test("mensagem recebida e não processada no prazo reconecta a loja", () => {
  const h = harness();
  h.open();
  h.sock.ws.emit("CB:ib,,offline", {});
  h.liveMessage("A");
  h.processed("A");
  h.liveMessage("B");
  h.advance(115_000);
  assert.equal(h.stalls.length, 0);
  h.advance(10_000);
  assert.equal(h.stalls.length, 1);
  assert.equal(h.stalls[0].reason, "inbound_pipeline_stuck");
});

test("mensagem descartada de propósito não conta como travamento quando as seguintes saem", () => {
  const h = harness();
  h.open();
  h.sock.ws.emit("CB:ib,,offline", {});
  h.liveMessage("descartada");
  h.liveMessage("B");
  h.processed("B");
  h.liveMessage("status", "status@broadcast");
  h.advance(600_000);
  assert.equal(h.stalls.length, 0);
});

test("fechar a conexão desliga a vigilância", () => {
  const h = harness();
  h.open();
  h.sock.ev.emit("connection.update", { connection: "close" });
  h.advance(600_000);
  assert.equal(h.stalls.length, 0);
  assert.equal(h.sock.ws.listenerCount("CB:message"), 0);
  assert.equal(h.sock.ev.listenerCount("messages.upsert"), 0);
});

test("recuperações repetidas esperam cada vez mais (sem martelar o WhatsApp)", () => {
  assert.equal(stallRecoveryDelayMs(1), 0);
  assert.equal(stallRecoveryDelayMs(2), 0);
  assert.equal(stallRecoveryDelayMs(3), 30_000);
  assert.equal(stallRecoveryDelayMs(4), 60_000);
  assert.equal(stallRecoveryDelayMs(20), 5 * 60_000);
});

const NOW = 1_800_000_000_000;
const msg = (id, { fromMe = false, ageMin = 1, jid = "5532999990000@s.whatsapp.net", text = "Oie" } = {}) => ({
  key: { id, fromMe, remoteJid: jid },
  messageTimestamp: Math.floor((NOW - ageMin * 60_000) / 1000),
  message: { conversation: text },
});

test("responde mensagens de cliente que chegaram durante a queda, em ordem", () => {
  const result = selectOfflineCustomerMessages([msg("b", { ageMin: 1 }), msg("a", { ageMin: 3 })], { now: NOW, maxAgeMs: 15 * 60_000 });
  assert.deepEqual(result.customerMessages.map((m) => m.key.id), ["a", "b"]);
  assert.deepEqual(result.storeTakeovers, []);
});

test("ignora mensagens antigas, de grupo, status e do próprio sistema", () => {
  const result = selectOfflineCustomerMessages([
    msg("velha", { ageMin: 40 }),
    msg("grupo", { jid: "123@g.us" }),
    msg("status", { jid: "status@broadcast" }),
    msg("eco", { fromMe: true, ageMin: 0 }),
  ], { now: NOW, maxAgeMs: 15 * 60_000 });
  assert.deepEqual(result.customerMessages, []);
  assert.deepEqual(result.storeTakeovers, []);
});

test("loja que já respondeu pelo celular durante a queda: robô não responde e pausa", () => {
  const result = selectOfflineCustomerMessages([
    msg("cliente", { ageMin: 5 }),
    msg("loja", { fromMe: true, ageMin: 4, text: "Oi! Já te atendo" }),
    msg("outro", { ageMin: 2, jid: "5532988887777@s.whatsapp.net" }),
  ], { now: NOW, maxAgeMs: 15 * 60_000 });
  assert.deepEqual(result.customerMessages.map((m) => m.key.id), ["outro"]);
  assert.deepEqual(result.storeTakeovers, ["5532999990000@s.whatsapp.net"]);
});

test("envio do próprio sistema não conta como resposta manual da loja", () => {
  const result = selectOfflineCustomerMessages([
    msg("cliente", { ageMin: 5 }),
    msg("robo", { fromMe: true, ageMin: 4 }),
  ], { now: NOW, maxAgeMs: 15 * 60_000, isOwnSend: (id) => id === "robo" });
  assert.deepEqual(result.customerMessages.map((m) => m.key.id), ["cliente"]);
});
