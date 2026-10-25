import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const moduleUrl = new URL("../dist/fatimaHandoff.js", import.meta.url);
const { FATIMA_TENANT_ID, FATIMA_INACTIVITY_MS, FATIMA_HUMAN_BUTTON_ID,
  extractFatimaChoice, isHumanChoice, handleFatimaMessage } = await import(moduleUrl.href);

const logger = { info() {}, warn() {} };
const tmp = await mkdtemp(join(tmpdir(), "fatima-handoff-test-"));
process.env.DATA_DIR = tmp;
test.after(async () => { await rm(tmp, { recursive: true, force: true }); });

function createFixture(jid, now) {
  const events = [];
  const base = {
    sessionId: FATIMA_TENANT_ID, customerJid: jid, logger,
    sendGreeting: async () => { events.push("menu"); },
    sendMessage: async (message) => { events.push(message); },
  };
  return {
    events,
    send: (text, at = now, overrides = {}) =>
      handleFatimaMessage({ ...base, text, now: at, ...overrides }),
  };
}

test("initial inbound receives menu, selection 2 pauses AI, and 6h idle reopens it", async () => {
  const start = Date.now();
  const fixture = createFixture("5511999000011@s.whatsapp.net", start);
  assert.equal(await fixture.send("Bom dia, queria uma encomenda"), true);
  assert.deepEqual(fixture.events, ["menu"]);
  assert.equal(await fixture.send("2", start + 1000), true);
  assert.match(fixture.events.at(-1), /atendente responderá/i);
  assert.equal(await fixture.send("100 minipães", start + 2 * 60 * 60 * 1000), true);
  assert.equal(fixture.events.filter((value) => value === "menu").length, 1);
  // Inactivity is measured since the customer's most recent message.
  assert.equal(await fixture.send("oi", start + 7 * 60 * 60 * 1000), true);
  assert.equal(fixture.events.filter((value) => value === "menu").length, 1);
  assert.equal(await fixture.send("oi", start + 8 * 60 * 60 * 1000 + FATIMA_INACTIVITY_MS), true);
  assert.equal(fixture.events.filter((value) => value === "menu").length, 2);
  assert.equal(await fixture.send("Quero pão", start + 8 * 60 * 60 * 1000 + FATIMA_INACTIVITY_MS + 1000), false);
});

test("other tenants retain their original WhatsApp flow", async () => {
  const now = Date.now();
  const fixture = createFixture("5511999000022@s.whatsapp.net", now);
  const handled = await fixture.send("2", now, { sessionId: "different-tenant-id" });
  assert.equal(handled, false);
  assert.deepEqual(fixture.events, []);
});

test("quick reply, explicit human phrases, and plain menu conversation", async () => {
  const now = Date.now();
  assert.equal(isHumanChoice("quero conversar"), true);
  assert.equal(isHumanChoice("Quero 2 pães"), false);
  assert.equal(isHumanChoice("2"), true);
  const rawMessage = {
    ephemeralMessage: { message: {
      interactiveResponseMessage: { nativeFlowResponseMessage: {
        paramsJson: JSON.stringify({ id: FATIMA_HUMAN_BUTTON_ID }),
      } },
    } },
  };
  assert.equal(extractFatimaChoice(rawMessage), FATIMA_HUMAN_BUTTON_ID);
  const fixture = createFixture("5511999000033@s.whatsapp.net", now);
  await fixture.send("oi");
  assert.equal(await fixture.send("", now + 10, { rawMessage }), true);
  assert.match(fixture.events.at(-1), /atendente/i);
});

test("failed greeting remains retryable and simultaneous greetings are deduplicated", async () => {
  const now = Date.now();
  const fixture = createFixture("5511999000044@s.whatsapp.net", now);
  await assert.rejects(fixture.send("oi", now, { sendGreeting: async () => { throw new Error("offline"); } }), /offline/);
  const results = await Promise.all([fixture.send("oi", now), fixture.send("oi de novo", now + 1)]);
  assert.deepEqual(results, [true, false]);
  assert.deepEqual(fixture.events, ["menu"]);
});

test("human mode persists across a process restart and is tenant-scoped", async () => {
  const now = Date.now();
  const jid = "5511999000055@s.whatsapp.net";
  const fixture = createFixture(jid, now);
  await fixture.send("oi", now);
  await fixture.send("2", now + 1);
  const persisted = JSON.parse(await readFile(join(tmp, "fatima-human-handoff.json"), "utf8"));
  assert.deepEqual(persisted[`${FATIMA_TENANT_ID}:${jid}`].mode, "human");

  const fresh = await import(`${moduleUrl.href}?fresh=${Date.now()}`);
  let greeted = false;
  const handled = await fresh.handleFatimaMessage({
    sessionId: FATIMA_TENANT_ID, customerJid: jid, text: "Ainda aguardando", now: now + 3000,
    logger, sendGreeting: async () => { greeted = true; }, sendMessage: async () => {},
  });
  assert.equal(handled, true);
  assert.equal(greeted, false);
});

test("invalid interactive reply does not select a human", () => {
  assert.equal(extractFatimaChoice({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: "{broken" } } }), "");
  assert.equal(isHumanChoice("2 pães"), false);
});
