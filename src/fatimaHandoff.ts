import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Tenant ID obtained from the canonical tenant record, not a mutable store name or slug.
export const FATIMA_TENANT_ID = "6256ec29-6460-4984-8647-dd97c20aaeff";
export const FATIMA_INACTIVITY_MS = 6 * 60 * 60 * 1000;
export const FATIMA_HUMAN_BUTTON_ID = "fatima_human_attendant";

type Mode = "menu" | "human";
type ContactState = { mode: Mode; lastActivityAt: number };
type Logger = {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
};
type Params = {
  sessionId: string;
  customerJid: string;
  text: string;
  rawMessage?: unknown;
  sendGreeting: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  logger: Logger;
  now?: number;
};

const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONTACTS = 5000;
const handoffs = new Map<string, ContactState>();
const pending = new Map<string, Promise<void>>();
let loadedFrom = "";
let loadPromise: Promise<void> | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let writeSequence = 0;

function stateFile() {
  return join(process.env.DATA_DIR || "/data/whatsapp-sessions", "fatima-human-handoff.json");
}

function contactKey(customerJid: string) {
  return `${FATIMA_TENANT_ID}:${customerJid.trim().toLowerCase()}`;
}

function normalize(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function unwrapMessage(value: any): any {
  let message = value;
  for (let depth = 0; message && depth < 6; depth += 1) {
    const nested = message.ephemeralMessage?.message || message.viewOnceMessage?.message ||
      message.viewOnceMessageV2?.message || message.documentWithCaptionMessage?.message;
    if (!nested) break;
    message = nested;
  }
  return message || {};
}

export function extractFatimaChoice(rawMessage: unknown): string {
  const message = unwrapMessage(rawMessage);
  const direct = message?.buttonsResponseMessage?.selectedButtonId ||
    message?.templateButtonReplyMessage?.selectedId ||
    message?.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (typeof direct === "string") return direct.slice(0, 100);

  const encoded = message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (typeof encoded === "string" && encoded.length <= 2000) {
    try {
      const data = JSON.parse(encoded);
      const selection = data?.id || data?.button_id || data?.selectedId;
      if (typeof selection === "string") return selection.slice(0, 100);
    } catch {
      return "";
    }
  }
  return "";
}

export function isHumanChoice(text: string, rawMessage?: unknown) {
  if (extractFatimaChoice(rawMessage) === FATIMA_HUMAN_BUTTON_ID) return true;
  return /^(?:2|atendente|conversar com (?:a loja|um atendente)|falar com (?:a loja|um atendente)|quero (?:conversar|falar com (?:a loja|um atendente))|prefiro conversar|atendimento humano)$/.test(normalize(text));
}

function prune(now: number) {
  for (const [key, state] of handoffs) {
    if (!Number.isFinite(state.lastActivityAt) || state.lastActivityAt > now || now - state.lastActivityAt > STATE_TTL_MS) {
      handoffs.delete(key);
    }
  }
  if (handoffs.size <= MAX_CONTACTS) return;
  const ordered = [...handoffs.entries()].sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt);
  for (const [key] of ordered.slice(0, handoffs.size - MAX_CONTACTS)) handoffs.delete(key);
}

async function loadState(logger: Logger) {
  const path = stateFile();
  if (loadedFrom === path) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const serialized = await readFile(path, "utf8");
        const data: unknown = JSON.parse(serialized);
        if (data && typeof data === "object" && !Array.isArray(data)) {
          for (const [key, value] of Object.entries(data)) {
            const state = value as Partial<ContactState>;
            if (key.startsWith(`${FATIMA_TENANT_ID}:`) &&
              (state.mode === "menu" || state.mode === "human") &&
              Number.isFinite(state.lastActivityAt)) {
              handoffs.set(key, { mode: state.mode, lastActivityAt: state.lastActivityAt! });
            }
          }
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          logger.warn({ error: error?.message || String(error) }, "[Fatima-Handoff] Failed to restore state; using clean state");
        }
      }
      prune(Date.now());
      loadedFrom = path;
    })().finally(() => { loadPromise = undefined; });
  }
  await loadPromise;
}

function saveState(logger: Logger, now: number) {
  prune(now);
  const path = stateFile();
  const contents = JSON.stringify(Object.fromEntries(handoffs));
  const write = async () => {
    const temporary = `${path}.${process.pid}.${++writeSequence}.tmp`;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  };
  writeQueue = writeQueue.catch(() => undefined).then(write);
  return writeQueue.catch((error: any) => {
    logger.warn({ error: error?.message || String(error) }, "[Fatima-Handoff] State persistence unavailable; keeping process-local state");
  });
}

async function routeMessage(params: Params): Promise<boolean> {
  await loadState(params.logger);
  const now = params.now ?? Date.now();
  const key = contactKey(params.customerJid);
  const state = handoffs.get(key);
  const expired = !state || now < state.lastActivityAt || now - state.lastActivityAt >= FATIMA_INACTIVITY_MS;

  if (expired) {
    await params.sendGreeting();
    handoffs.set(key, { mode: "menu", lastActivityAt: now });
    await saveState(params.logger, now);
    params.logger.info({ sessionId: params.sessionId }, "[Fatima-Handoff] Initial menu sent");
    return true;
  }

  if (state.mode === "human") {
    state.lastActivityAt = now;
    await saveState(params.logger, now);
    return true;
  }

  if (isHumanChoice(params.text, params.rawMessage)) {
    // Record the handoff before sending the acknowledgment so no AI handler races it.
    handoffs.set(key, { mode: "human", lastActivityAt: now });
    await saveState(params.logger, now);
    await params.sendMessage("Combinado! 💬 Vou deixar a conversa com a equipe da Padaria Fátima. Um atendente responderá assim que possível.");
    params.logger.info({ sessionId: params.sessionId }, "[Fatima-Handoff] Human atendimento activated");
    return true;
  }

  state.lastActivityAt = now;
  await saveState(params.logger, now);
  return false;
}

export async function handleFatimaMessage(params: Params): Promise<boolean> {
  if (params.sessionId !== FATIMA_TENANT_ID) return false;
  if (!params.customerJid || (!params.text.trim() && !extractFatimaChoice(params.rawMessage))) return false;

  const key = contactKey(params.customerJid);
  const earlier = pending.get(key) || Promise.resolve();
  let release!: () => void;
  const completed = new Promise<void>((resolve) => { release = resolve; });
  const chained = earlier.catch(() => undefined).then(() => completed);
  pending.set(key, chained);
  try {
    await earlier.catch(() => undefined);
    return await routeMessage(params);
  } finally {
    release();
    if (pending.get(key) === chained) pending.delete(key);
  }
}
