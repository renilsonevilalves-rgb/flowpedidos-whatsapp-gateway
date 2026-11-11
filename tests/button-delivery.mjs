import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

const { watchDeviceReceipt, buttonsRecentlyUndelivered, markButtonUndelivered, markButtonDelivered } =
  await import("../dist/buttonDelivery.js");

function fakeSock(id = "5531999990000:12@s.whatsapp.net") {
  const ws = new EventEmitter();
  return { ws, user: { id } };
}

test("botão confirmado quando algum aparelho devolve recibo", async () => {
  const sock = fakeSock();
  const watch = watchDeviceReceipt(sock, "MSG1");
  setTimeout(() => sock.ws.emit("CB:receipt", { attrs: { id: "MSG1", from: "1@lid" } }), 5);
  assert.equal(await watch.wait(500), true);
  assert.equal(sock.ws.listenerCount("CB:receipt"), 0);
});

test("recibo que chega antes de esperar também conta (lista de ids inclusive)", async () => {
  const sock = fakeSock();
  const watch = watchDeviceReceipt(sock, "MSG3");
  sock.ws.emit("CB:receipt", { attrs: { id: "MSG2" }, content: [{ tag: "list", content: [{ attrs: { id: "MSG3" } }] }] });
  assert.equal(await watch.wait(500), true);
});

test("só ACK do servidor, sem recibo de aparelho: não confirmado", async () => {
  const sock = fakeSock();
  const watch = watchDeviceReceipt(sock, "MSG4");
  sock.ws.emit("CB:ack,class:message", { attrs: { id: "MSG4" } });
  sock.ws.emit("CB:receipt", { attrs: { id: "OUTRA" } });
  assert.equal(await watch.wait(30), false);
});

test("sem socket bruto mantém o comportamento antigo (assume entregue)", async () => {
  assert.equal(await watchDeviceReceipt({}, "X").wait(10), true);
});

test("conta com botão não entregue recebe texto direto até o botão voltar a funcionar", () => {
  const sock = fakeSock("5531888880000:3@s.whatsapp.net");
  assert.equal(buttonsRecentlyUndelivered(sock), false);
  markButtonUndelivered(sock);
  assert.equal(buttonsRecentlyUndelivered(sock), true);
  assert.equal(buttonsRecentlyUndelivered(fakeSock("5531777770000:1@s.whatsapp.net")), false);
  assert.equal(buttonsRecentlyUndelivered(sock, Date.now() + 3 * 60 * 60 * 1000), false);
  markButtonUndelivered(sock);
  markButtonDelivered(sock);
  assert.equal(buttonsRecentlyUndelivered(sock), false);
});

test("saudação só conta o botão como enviado depois do recibo; senão manda texto com link", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const patch = readFileSync(new URL("../scripts/patch-greeting-menu-button.cjs", import.meta.url), "utf8");
  assert.ok(server.includes('import { showTypingThenWait } from "./naturalPacing.js";'));
  assert.match(patch, /const receipt = watchDeviceReceipt\(sock, message\.key\.id\);\n\s+await sock\.relayMessage/);
  assert.match(patch, /if \(!\(await receipt\.wait\(\)\)\) \{[\s\S]*markButtonUndelivered\(sock\);[\s\S]*menuUrl[\s\S]*return "text-fallback-undelivered";/);
  assert.match(patch, /if \(buttonsRecentlyUndelivered\(sock\)\) throw/);
});
