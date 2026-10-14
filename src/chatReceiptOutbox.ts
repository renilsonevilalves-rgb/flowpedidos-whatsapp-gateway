// src/chatReceiptOutbox.ts
// Durable, encrypted delivery outbox. The backend has already committed the
// order; this module sends (or re-sends) its receipt, never commits again.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Receipt = { sessionId: string; customerJid: string; orderId: string; text: string; createdAt: number;
  draftId?: string; phone?: string };
type Log = { warn: (fields: Record<string, unknown>, message: string) => void;
  info?: (fields: Record<string, unknown>, message: string) => void };
type Sender = (jid: string, data: { text: string }) => Promise<unknown>;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const busy = new Set<string>();
const draining = new Set<string>();
const secret = () => String(process.env.API_KEY || process.env.API_KEY_2 || "");
const dir = () => process.env.WHATSAPP_RECEIPT_DIR ||
  join(dirname(process.env.DATA_DIR || "/data/whatsapp-sessions"), "whatsapp-chat-receipts");
const key = () => createHash("sha256").update("whatsapp-receipts-v1:" + secret()).digest();
const file = (sessionId: string, jid: string, orderId: string) => join(dir(),
  createHmac("sha256", secret()).update(JSON.stringify([sessionId, jid, orderId])).digest("hex") + ".json");

const orderReceiptPath = (receipt: Receipt) =>
  file(receipt.sessionId, receipt.customerJid, receipt.draftId || receipt.orderId);
const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isPrepared = (receipt: Receipt) =>
  !receipt.text && Boolean(receipt.draftId && receipt.phone);

async function store(receipt: Receipt): Promise<string> {
  if (!secret()) throw new Error("Receipt encryption key unavailable");
  if (!receipt.sessionId || !receipt.customerJid || !receipt.orderId ||
      (!receipt.text && !isPrepared(receipt)) || receipt.text.length > 3800 ||
      (receipt.draftId && !isUuid(receipt.draftId)) ||
      (receipt.phone && !/^55[1-9]{2}\d{8,9}$/.test(receipt.phone)))
    throw new Error("Invalid order receipt");
  const path = orderReceiptPath(receipt);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(receipt), "utf8"), cipher.final()]);
  const envelope = JSON.stringify({
    version: 1, nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64"),
  });
  await mkdir(dir(), { recursive: true, mode: 0o700 });
  const tmp = path + "." + randomBytes(6).toString("hex") + ".tmp";
  try {
    await writeFile(tmp, envelope, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  return path;
}

async function read(path: string): Promise<Receipt | null> {
  if (!secret()) return null;
  try {
    const raw = await readFile(path);
    if (raw.length > 12000) return null;
    const body = JSON.parse(raw.toString("utf8"));
    if (body.version !== 1) return null;
    const nonce = Buffer.from(body.nonce, "base64");
    const tag = Buffer.from(body.tag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), nonce);
    decipher.setAuthTag(tag);
    const receipt = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(body.data, "base64")), decipher.final(),
    ]).toString("utf8")) as Receipt;
    if (!receipt?.sessionId || !receipt?.customerJid || !receipt?.orderId ||
        typeof receipt.text !== "string" || receipt.text.length > 3800 ||
        (!receipt.text && !isPrepared(receipt)) ||
        (receipt.draftId && !isUuid(receipt.draftId)) ||
        (receipt.phone && !/^55[1-9]{2}\d{8,9}$/.test(receipt.phone)) ||
        !Number.isFinite(receipt.createdAt)) return null;
    return receipt;
  } catch { return null; }
}

async function sendWithRetry(receipt: Receipt, sendMessage: Sender, log: Log): Promise<boolean> {
  const path = orderReceiptPath(receipt);
  if (busy.has(path) || !receipt.text) return false;
  busy.add(path);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await sendMessage(receipt.customerJid, { text: receipt.text });
        await unlink(path).catch(() => undefined);
        log.info?.({ sessionId: receipt.sessionId }, "[Chat-Receipt] Confirmation dispatched");
        return true;
      } catch {
        log.warn({ sessionId: receipt.sessionId, attempt: attempt + 1 },
          "[Chat-Receipt] WhatsApp confirmation delivery deferred");
      }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 650));
    }
    return false;
  } finally { busy.delete(path); }
}

export async function prepareOrderReceipt(input: {
  sessionId: string; customerJid: string; draftId: string; phone: string;
}): Promise<void> {
  if (!isUuid(input.draftId) || !/^55[1-9]{2}\d{8,9}$/.test(input.phone))
    throw new Error("Invalid prepared receipt");
  await store({ ...input, orderId: "pending:" + input.draftId, text: "", createdAt: Date.now() });
}

// Recovers a confirmed SQL order using tenant+phone+draft idempotency key.
// Never invokes commit again.
async function reconcileReceipt(receipt: Receipt, log: Log): Promise<Receipt | null> {
  if (!isPrepared(receipt) || !isUuid(receipt.draftId || "") ||
      !process.env.VERCEL_API_URL) return null;
  const endpoint = process.env.VERCEL_API_URL.replace(/\/$/, "") +
    "/api/webhook/whatsapp/chat-order";
  for (const apiKey of [process.env.API_KEY, process.env.API_KEY_2].filter(Boolean)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(endpoint, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-API-Key": String(apiKey) },
        body: JSON.stringify({ action: "receipt", sessionId: receipt.sessionId,
          phone: receipt.phone, draftId: receipt.draftId }),
      });
      if (response.status === 401) continue;
      if (!response.ok) return null;
      const data = await response.json().catch(() => ({}));
      const total = Number(data.total);
      if (data.ok !== true || data.found !== true ||
          typeof data.orderNumber !== "string" ||
          !/^[a-zA-Z0-9-]{1,30}$/.test(data.orderNumber) ||
          !Number.isFinite(total) || total < 0) return null;
      const amount = new Intl.NumberFormat("pt-BR",
        { style: "currency", currency: "BRL" }).format(total);
      const message = "✅ *Pedido #" + data.orderNumber + " confirmado!*\n" +
        "Total: *" + amount + "*\n" +
        String(data.message || "Pedido confirmado.").slice(0, 600) +
        (typeof data.paymentUrl === "string" &&
          /^https:\/\/clickaipedidos\.com\.br\//.test(data.paymentUrl)
          ? "\n\n🔒 Link de pagamento:\n" + data.paymentUrl.slice(0, 360) : "");
      const restored = { ...receipt, orderId: String(data.orderId || receipt.orderId), text: message };
      await store(restored);
      log.info?.({ sessionId: receipt.sessionId }, "[Chat-Receipt] Previous SQL commit found");
      return restored;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  return null;
}

export async function deliverOrderReceipt(
  receipt: Omit<Receipt, "createdAt">, sendMessage: Sender, log: Log,
): Promise<boolean> {
  const full = { ...receipt, createdAt: Date.now() };
  // Persist before sending: a restart after DB commit must not lose the receipt.
  try { await store(full); }
  catch { log.warn({ sessionId: receipt.sessionId }, "[Chat-Receipt] Unable to persist confirmation"); }
  return sendWithRetry(full, sendMessage, log);
}

// Called after each successful WhatsApp reconnection. May resend a confirmation
// once if a crash happened after WhatsApp accepted the send but before unlink;
// it can NEVER create a duplicate order.
export async function drainOrderReceipts(sessionId: string, sendMessage: Sender, log: Log): Promise<number> {
  if (!secret() || draining.has(sessionId)) return 0;
  draining.add(sessionId);
  try {
  let names: string[];
  try { names = await readdir(dir()); } catch { return 0; }
  let sent = 0;
  for (const name of names.filter(n => /^[0-9a-f]{64}\.json$/.test(n)).slice(0, 250)) {
    const path = join(dir(), name);
    if (busy.has(path)) continue;
    const receipt = await read(path);
    if (!receipt) continue;
    if (Date.now() - receipt.createdAt > MAX_AGE_MS) {
      await unlink(path).catch(() => undefined);
      continue;
    }
    if (receipt.sessionId !== sessionId || path !== orderReceiptPath(receipt)) continue;
    const confirmed = isPrepared(receipt) ? await reconcileReceipt(receipt, log) : receipt;
    if (confirmed?.text && await sendWithRetry(confirmed, sendMessage, log)) sent++;
  }
  if (sent) log.info?.({ sessionId, sent }, "[Chat-Receipt] Pending confirmations recovered");
  return sent;
  } finally { draining.delete(sessionId); }
}
