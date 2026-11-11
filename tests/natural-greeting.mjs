import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { periodGreeting, applyPeriodGreeting } = await import("../dist/greeting.js");
const { typingDelayMs, showTypingThenWait } = await import("../dist/naturalPacing.js");

// Horário de Brasília = UTC-3.
const brt = (hour, minute = 0) => new Date(Date.UTC(2026, 10, 11, hour + 3, minute));

test("saudação acompanha o horário de Brasília", () => {
  assert.equal(periodGreeting(brt(4, 59)), "Boa noite");
  assert.equal(periodGreeting(brt(5, 0)), "Bom dia");
  assert.equal(periodGreeting(brt(11, 59)), "Bom dia");
  assert.equal(periodGreeting(brt(12, 0)), "Boa tarde");
  assert.equal(periodGreeting(brt(17, 59)), "Boa tarde");
  assert.equal(periodGreeting(brt(18, 0)), "Boa noite");
  assert.equal(periodGreeting(brt(23, 30)), "Boa noite");
});

test("Olá/Oi genérico no início vira a saudação do período, o resto fica intacto", () => {
  assert.equal(applyPeriodGreeting("Olá! 👋 Seja bem-vindo", brt(9)), "Bom dia! 👋 Seja bem-vindo");
  assert.equal(applyPeriodGreeting("Oi, tudo bem?", brt(14)), "Boa tarde, tudo bem?");
  assert.equal(applyPeriodGreeting("Olívia te atende", brt(14)), "Olívia te atende");
  assert.equal(applyPeriodGreeting("Seja bem-vindo!", brt(14)), "Seja bem-vindo!");
});

test("tempo de digitação fica entre 1,2s e 4s", () => {
  assert.equal(typingDelayMs("", () => 0), 1200);
  assert.equal(typingDelayMs("x".repeat(2000), () => 1), 4000);
  const mid = typingDelayMs("x".repeat(100), () => 0.5);
  assert.ok(mid > 1200 && mid < 4000);
});

test("falha de presença nunca impede o envio e grupos são ignorados", async () => {
  const calls = [];
  const sock = { sendPresenceUpdate: async (state, jid) => { calls.push([state, jid]); throw new Error("boom"); } };
  await showTypingThenWait(sock, "5511999999999@s.whatsapp.net", "");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.map((c) => c[0]), ["composing", "paused"]);
  calls.length = 0;
  await showTypingThenWait(sock, "123@g.us", "oi");
  assert.equal(calls.length, 0);
});

test("presença travada não segura a resposta", async () => {
  const sock = { sendPresenceUpdate: () => new Promise(() => {}) };
  const started = Date.now();
  await showTypingThenWait(sock, "5511999999999@s.whatsapp.net", "");
  assert.ok(Date.now() - started < 4500);
});

test("o gateway aplica digitando, saudação por período e anti-repetição", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /showTypingThenWait\(sock, jid, pacedText\)/);
  assert.match(server, /showTypingThenWait\(sock, customerJid, replyText\)/);
  assert.match(server, /\$\{periodGreeting\(\)\}! 👋/);
  assert.match(server, /applyPeriodGreeting\(configured\)/);
  assert.match(server, /skipped-recent/);
});
