// tests/chat-order-receipts.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.API_KEY = "receipt-test-secure-key";
process.env.VERCEL_API_URL = "https://backend.test";
const {
  stageOrderReceipt, confirmOrderReceipt, clearOrderReceipt, flushPendingOrderReceipts,
} = await import("../dist/chatReceiptOutbox.js");
const logger = { info() {}, warn() {} };
const SESSION = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "5531999955577";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const receiptId = { sessionId: SESSION,
  customerJid: CUSTOMER + "@s.whatsapp.net", phone: CUSTOMER, draftId: DRAFT };
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("prepared receipt survives a gateway restart and reconciles only by read-only receipt action", async () => {
  const folder = await mkdtemp(join(tmpdir(), "wa-receipt-recovery-"));
  const oldDirectory = process.env.CHAT_RECEIPTS_DIR, originalFetch = globalThis.fetch;
  process.env.CHAT_RECEIPTS_DIR = folder;
  const actions = [], sent = [];
  globalThis.fetch = async (_url, opts) => {
    const req = JSON.parse(opts.body);
    actions.push(req);
    assert.equal(req.action, "receipt");
    assert.equal(req.sessionId, SESSION);
    assert.equal(req.draftId, DRAFT);
    assert.equal(req.phone, CUSTOMER);
    return response({ ok: true, found: true, orderNumber: "6012",
      total: 62.78, message: "Pedido confirmado e encaminhado à loja." });
  };
  try {
    await stageOrderReceipt(receiptId);
    const hashedStores = await readdir(folder);
    assert.equal(hashedStores.length, 1);
    assert.doesNotMatch(hashedStores[0], /22222222|553199/);
    const files = await readdir(join(folder, hashedStores[0]));
    assert.equal(files.length, 1);
    const stored = await readFile(join(folder, hashedStores[0], files[0]), "utf8");
    assert.doesNotMatch(stored, /6012|553199|22222222|44444444/);

    assert.equal(await flushPendingOrderReceipts(OTHER,
      async () => { throw Error("wrong tenant"); }, logger), 0);
    assert.equal(await flushPendingOrderReceipts(SESSION, async (jid, text) => {
      sent.push({ jid, text });
    }, logger), 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, receiptId.customerJid);
    assert.match(sent[0].text, /Pedido #6012/);
    assert.match(sent[0].text, /62,78/);
    assert.equal(actions.length, 1);
    assert.equal(actions.some(x => x.action === "commit"), false);
    assert.equal(await flushPendingOrderReceipts(SESSION, async () => {}, logger), 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldDirectory === undefined) delete process.env.CHAT_RECEIPTS_DIR;
    else process.env.CHAT_RECEIPTS_DIR = oldDirectory;
    await rm(folder, { recursive: true, force: true });
  }
});

test("failed WhatsApp send retains encrypted receipt; a retry delivers without another commit", async () => {
  const folder = await mkdtemp(join(tmpdir(), "wa-receipt-retry-"));
  const oldDirectory = process.env.CHAT_RECEIPTS_DIR, originalFetch = globalThis.fetch;
  process.env.CHAT_RECEIPTS_DIR = folder;
  let sent = 0, networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw Error("Unexpected backend call"); };
  try {
    await stageOrderReceipt(receiptId);
    await confirmOrderReceipt(receiptId, "✅ Pedido #6012 — R$ 62,78\nPedido confirmado.");
    assert.equal(await flushPendingOrderReceipts(SESSION, async () => {
      throw Error("WhatsApp connection interrupted");
    }, logger), 0);
    assert.equal(await flushPendingOrderReceipts(SESSION, async (_jid, text) => {
      sent++; assert.match(text, /6012/);
    }, logger), 1);
    assert.equal(sent, 1);
    assert.equal(networkCalls, 0);
    assert.equal(await flushPendingOrderReceipts(SESSION, async () => {}, logger), 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldDirectory === undefined) delete process.env.CHAT_RECEIPTS_DIR;
    else process.env.CHAT_RECEIPTS_DIR = oldDirectory;
    await rm(folder, { recursive: true, force: true });
  }
});

test("uncommitted prepare is never announced as a real order", async () => {
  const folder = await mkdtemp(join(tmpdir(), "wa-receipt-noorder-"));
  const oldDirectory = process.env.CHAT_RECEIPTS_DIR, originalFetch = globalThis.fetch;
  process.env.CHAT_RECEIPTS_DIR = folder;
  let sent = 0;
  globalThis.fetch = async (_url, opts) => {
    assert.equal(JSON.parse(opts.body).action, "receipt");
    return response({ ok: true, found: false });
  };
  try {
    await stageOrderReceipt(receiptId);
    assert.equal(await flushPendingOrderReceipts(SESSION, async () => { sent++; }, logger), 0);
    assert.equal(sent, 0);
    await clearOrderReceipt(receiptId);
    assert.equal(await flushPendingOrderReceipts(SESSION, async () => {}, logger), 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldDirectory === undefined) delete process.env.CHAT_RECEIPTS_DIR;
    else process.env.CHAT_RECEIPTS_DIR = oldDirectory;
    await rm(folder, { recursive: true, force: true });
  }
});
