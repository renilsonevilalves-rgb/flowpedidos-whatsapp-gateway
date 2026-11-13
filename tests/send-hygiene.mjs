// Boas práticas de envio: fila sem rajada, sem repetição e respeito ao "parar".
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.DATA_DIR = tmpdir() + "/send-hygiene-" + process.pid;
process.env.WHATSAPP_MIN_SEND_GAP_MS = "40";
process.env.WHATSAPP_MAX_SENDS_PER_MINUTE = "1000";
const h = await import("../dist/sendHygiene.js");

test("envios da mesma loja saem em fila com intervalo mínimo", async () => {
  h.resetSendHygieneForTests();
  const times = [];
  await Promise.all([1, 2, 3].map(async () => { await h.waitForSendSlot("loja"); times.push(Date.now()); }));
  times.sort((a, b) => a - b);
  assert.ok(times[1] - times[0] >= 35 && times[2] - times[1] >= 35, JSON.stringify(times));
});

test("mesma mensagem repetida em seguida é descartada, mas resposta a nova mensagem do cliente sai", () => {
  h.resetSendHygieneForTests();
  const now = Date.now();
  assert.equal(h.isDuplicateSend("loja", "5531999990000@s.whatsapp.net", "Seu pedido saiu", 0, now), false);
  assert.equal(h.isDuplicateSend("loja", "553199990000@s.whatsapp.net", "seu pedido  saiu", 0, now + 1000), true, "mesmo número sem o 9");
  assert.equal(h.isDuplicateSend("loja", "5531999990000@s.whatsapp.net", "Seu pedido saiu", now + 2000, now + 3000), false, "cliente escreveu de novo");
  assert.equal(h.isDuplicateSend("loja", "5531999990000@s.whatsapp.net", "Outra mensagem", 0, now + 3000), false);
  assert.equal(h.isDuplicateSend("loja", "5531999990000@s.whatsapp.net", "Seu pedido saiu", 0, now + 400_000), false, "depois da janela");
});

test("'parar' desliga e 'voltar' religa os avisos, por loja", async () => {
  h.resetSendHygieneForTests();
  for (const t of ["parar", "Pare!", "não quero mais receber mensagens", "STOP"]) assert.equal(h.isOptOutRequest(t), true, t);
  for (const t of ["quero cancelar", "parar de comer", "sair de casa agora", "oi"]) assert.equal(h.isOptOutRequest(t), false, t);
  assert.equal(h.isOptInRequest("voltar"), true);
  await h.setOptOut("loja", "5531999990000", true);
  assert.equal(await h.hasOptedOut("loja", "31999990000"), true);
  assert.equal(await h.hasOptedOut("outra-loja", "31999990000"), false);
  await h.setOptOut("loja", "5531999990000", false);
  assert.equal(await h.hasOptedOut("loja", "5531999990000"), false);
});
