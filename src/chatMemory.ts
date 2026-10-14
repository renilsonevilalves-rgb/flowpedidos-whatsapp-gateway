// src/chatMemory.ts
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ChatTurn = { role: "user" | "assistant"; text: string };
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TURNS = 80;
const MAX_TEXT = 800;
const MAX_FILE_BYTES = 96 * 1024;

function memorySecret(): string {
  return String(process.env.API_KEY || process.env.API_KEY_2 || "");
}

function storageDir(): string {
  return process.env.CHAT_MEMORY_DIR || join(dirname(process.env.DATA_DIR || "/data/whatsapp-sessions"), "whatsapp-chat-memory");
}

function memoryPath(sessionId: string, customerJid: string): string | null {
  const secret = memorySecret();
  if (!secret || !sessionId || !customerJid) return null;
  const hashed = createHmac("sha256", secret)
    .update("chat-memory-v1:").update(sessionId).update(":").update(customerJid)
    .digest("hex");
  return join(storageDir(), hashed + ".json");
}

function encryptionKey(): Buffer {
  return createHash("sha256").update("chat-memory-encryption-v1:" + memorySecret()).digest();
}

function sanitizedHistory(input: ChatTurn[]): ChatTurn[] {
  if (!Array.isArray(input)) return [];
  return input.slice(-MAX_TURNS).filter(turn => turn?.role === "user" || turn?.role === "assistant")
    .map(turn => ({
      role: turn.role,
      text: String(turn.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT),
    })).filter(turn => turn.text);
}

export async function loadChatMemory(sessionId: string, customerJid: string): Promise<ChatTurn[]> {
  const path = memoryPath(sessionId, customerJid);
  if (!path) return [];
  try {
    const raw = await readFile(path);
    if (raw.length > MAX_FILE_BYTES) return [];
    const envelope = JSON.parse(raw.toString("utf8"));
    if (envelope?.version !== 1 || !Number.isFinite(envelope.expiresAt)) return [];
    if (Date.now() >= envelope.expiresAt) {
      await unlink(path).catch(() => undefined);
      return [];
    }
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const encrypted = Buffer.from(envelope.data, "base64");
    if (nonce.length !== 12 || tag.length !== 16) return [];
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
    decipher.setAuthTag(tag);
    const body = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(body.toString("utf8"));
    return sanitizedHistory(payload?.history || []);
  } catch {
    return [];
  }
}

export async function saveChatMemory(sessionId: string, customerJid: string, history: ChatTurn[]): Promise<void> {
  const path = memoryPath(sessionId, customerJid);
  if (!path) return;
  let temporary = "";
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
    const clear = Buffer.from(JSON.stringify({ history: sanitizedHistory(history) }), "utf8");
    const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1, expiresAt: Date.now() + RETENTION_MS,
      nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    });
    if (Buffer.byteLength(envelope) > MAX_FILE_BYTES) return;
    await mkdir(storageDir(), { recursive: true, mode: 0o700 });
    temporary = path + "." + randomBytes(6).toString("hex") + ".tmp";
    await writeFile(temporary, envelope, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    if (temporary) await unlink(temporary).catch(() => undefined);
    // Conversation memory is optional: filesystem problems cannot interrupt orders.
  }
}
