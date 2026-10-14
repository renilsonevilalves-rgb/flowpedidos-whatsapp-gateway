// src/chatReceiptOutbox.ts
// Durable, tenant-scoped confirmation receipts. A successful backend commit can
// be recovered after Railway restarts, without submitting the order again.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Receipt = {
  sessionId: string; customerJid: string; phone: string; draftId: string;
  createdAt: number; message?: string;
};
type Logger = { info?: (data: Record<string, unknown>, msg: string) => void;
  warn: (data: Record<string, unknown>, msg: string) => void };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE = /^55[1-9]{2}\d{8,9}$/;
const JID = /^[0-9]{10,20}(?::\d+)?@(s\.whatsapp\.net|lid)$/;
const TTL = 12 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 16 * 1024;
const inFlight = new Set<string>();
const secret = () => String(process.env.API_KEY || process.env.API_KEY_2 || "");
function rootDir() {
  return process.env.CHAT_RECEIPTS_DIR ||
    join(dirname(process.env.DATA_DIR || "/data/whatsapp-sessions"), "whatsapp-order-receipts");
}
function folder(sessionId: string) {
  return join(rootDir(), createHmac("sha256", secret()).update("receipt-store:" + sessionId).digest("hex"));
}
function pathOf(info: Pick<Receipt, "sessionId" | "customerJid" | "draftId">) {
  const name = createHmac("sha256", secret()).update(
    "receipt:" + info.sessionId + ":" + info.customerJid + ":" + info.draftId).digest("hex");
  return join(folder(info.sessionId), name + ".json");
}
function valid(info: Receipt) {
  return Boolean(secret() && UUID.test(info.sessionId) && UUID.test(info.draftId) &&
    PHONE.test(info.phone) && JID.test(info.customerJid) &&
    Number.isFinite(info.createdAt) && info.createdAt <= Date.now() + 60000 &&
    Date.now() - info.createdAt < TTL && (!info.message || info.message.length <= 4000));
}
function key() {
  return createHash("sha256").update("whatsapp-confirmation-outbox-v1:" + secret()).digest();
}
async function writeReceipt(info: Receipt) {
  if (!valid(info)) throw new Error("Invalid confirmation receipt");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(info))), cipher.final()]);
  const envelope = JSON.stringify({ version: 1, nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
  if (Buffer.byteLength(envelope) > MAX_FILE_BYTES) throw new Error("Confirmation receipt too large");
  const file = pathOf(info);
  await mkdir(folder(info.sessionId), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomBytes(6).toString("hex") + ".tmp";
  try {
    await writeFile(temporary, envelope, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => undefined); }
}
async function readReceipt(file: string): Promise<Receipt | null> {
  try {
    const buffer = await readFile(file);
    if (buffer.byteLength > MAX_FILE_BYTES) return null;
    const raw = JSON.parse(buffer.toString("utf8"));
    if (raw.version !== 1) return null;
    const nonce = Buffer.from(raw.nonce, "base64");
    const tag = Buffer.from(raw.tag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), nonce);
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]);
    const receipt = JSON.parse(payload.toString("utf8")) as Receipt;
    return valid(receipt) ? receipt : null;
  } catch { return null; }
}
export async function stageOrderReceipt(input: Omit<Receipt, "createdAt" | "message">): Promise<void> {
  await writeReceipt({ ...input, createdAt: Date.now() });
}
export async function confirmOrderReceipt(input: Omit<Receipt, "createdAt" | "message">,
  message: string): Promise<void> {
  // Keep a prepared receipt intact when a failed filesystem write occurs.
  const current = await readReceipt(pathOf(input));
  if (!current) throw new Error("Prepared confirmation receipt missing");
  await writeReceipt({ ...current, message: String(message).slice(0, 4000) });
}
export async function clearOrderReceipt(input: Pick<Receipt, "sessionId" | "customerJid" | "draftId">): Promise<void> {
  await unlink(pathOf(input)).catch(error => { if (error?.code !== "ENOENT") throw error; });
}
async function resolveConfirmedReceipt(receipt: Receipt, logger: Logger): Promise<Receipt | null> {
  if (receipt.message) return receipt;
  // A prepared record means the previous process could have died after
  // Supabase committed but before acknowledging the result. Reconcile using
  // a read-only, tenant+phone+draft-id idempotency lookup: NEVER re-commit.
  const url = String(process.env.VERCEL_API_URL || "").replace(/\/$/, "") +
    "/api/webhook/whatsapp/chat-order";
  for (const apiKey of [process.env.API_KEY, process.env.API_KEY_2].filter(Boolean)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);
    try {
      const response = await fetch(url, { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-API-Key": String(apiKey) },
        body: JSON.stringify({
          action: "receipt", sessionId: receipt.sessionId,
          phone: receipt.phone, draftId: receipt.draftId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) continue;
      if (!response.ok || data.ok !== true) return null;
      if (!data.found) return null;
      const amount = Number(data.total);
      if (!Number.isFinite(amount) || amount < 0 || !data.orderNumber) return null;
      const amountText = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(amount);
      const message = "✅ Pedido #" + String(data.orderNumber).slice(0, 30) +
        " — " + amountText + "\n" + String(data.message || "Pedido confirmado.").slice(0, 350) +
        (data.paymentUrl ? "\n\n🔒 Link de pagamento:\n" + String(data.paymentUrl).slice(0, 350) : "");
      const updated = { ...receipt, message };
      await writeReceipt(updated);
      logger.info?.({ sessionId: receipt.sessionId }, "[Chat-Receipt] Previously committed order recovered");
      return updated;
    } catch {
      return null;
    } finally { clearTimeout(timeout); }
  }
  return null;
}

export async function flushPendingOrderReceipts(sessionId: string,
  send: (customerJid: string, text: string) => Promise<unknown>, logger: Logger): Promise<number> {
  if (!secret() || !UUID.test(sessionId) || inFlight.has(sessionId)) return 0;
  inFlight.add(sessionId);
  let delivered = 0;
  try {
    const directory = folder(sessionId);
    const files = await readdir(directory).catch(() => [] as string[]);
    // Bounded startup work and database lookups. Every file is encrypted.
    for (const fileName of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 100)) {
      const file = join(directory, fileName);
      const receipt = await readReceipt(file);
      if (!receipt) { await unlink(file).catch(() => undefined); continue; }
      if (receipt.sessionId !== sessionId || pathOf(receipt) !== file) continue;
      const confirmed = await resolveConfirmedReceipt(receipt, logger);
      if (!confirmed?.message) continue;
      try {
        await send(confirmed.customerJid, confirmed.message);
        await clearOrderReceipt(confirmed);
        delivered++;
        logger.info?.({ sessionId }, "[Chat-Receipt] Confirmation delivered");
      } catch {
        logger.warn({ sessionId }, "[Chat-Receipt] Delivery deferred until next connection");
      }
    }
  } catch {
    logger.warn({ sessionId }, "[Chat-Receipt] Recovery scan unavailable");
  } finally { inFlight.delete(sessionId); }
  return delivered;
}
