// src/humanHandoff.ts
// "Atendimento humano": while paused, no automatic reply is sent to that
// customer. Pauses survive restarts (JSON file on the persistent volume).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Reason = "customer_request" | "manual_reply";
type Pause = { until: number; reason: Reason };

const MAX_ENTRIES = 5000;
const pauses = new Map<string, Pause>();
let loaded: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function file() {
  return process.env.HUMAN_HANDOFF_FILE ||
    join(process.env.DATA_DIR || "/data/whatsapp-sessions", "human-handoff.json");
}

// Same customer, whether the JID arrives as phone (@s.whatsapp.net) or LID.
export function contactKey(sessionId: string, customerJid: string) {
  return `${sessionId}:${String(customerJid || "").trim().toLowerCase()}`;
}

function ensureLoaded() {
  if (!loaded) {
    loaded = readFile(file(), "utf8").then((raw) => {
      const data = JSON.parse(raw);
      const now = Date.now();
      for (const [key, value] of Object.entries(data || {})) {
        const pause = value as Pause;
        if (pause && Number(pause.until) > now) pauses.set(key, { until: Number(pause.until), reason: pause.reason });
      }
    }).catch(() => undefined);
  }
  return loaded;
}

function persist() {
  const snapshot = JSON.stringify(Object.fromEntries(pauses));
  writeQueue = writeQueue.then(async () => {
    const target = file();
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, snapshot, "utf8");
    await rename(temp, target);
  }).catch(() => undefined);
  return writeQueue;
}

export async function pauseAi(sessionId: string, customerJid: string, minutes: number, reason: Reason) {
  await ensureLoaded();
  const key = contactKey(sessionId, customerJid);
  const until = Date.now() + Math.max(1, minutes) * 60_000;
  // A manual reply never shortens a longer customer-requested pause.
  const current = pauses.get(key);
  if (current && current.until > until) return;
  pauses.set(key, { until, reason });
  if (pauses.size > MAX_ENTRIES) pauses.delete(pauses.keys().next().value as string);
  await persist();
}

export async function resumeAi(sessionId: string, customerJid: string) {
  await ensureLoaded();
  if (pauses.delete(contactKey(sessionId, customerJid))) await persist();
}

const RESUME = /\b(?:voltar (?:ao|pro|para o|pra o) (?:robo|bot|automatico|atendimento automatico|assistente)|falar com (?:o )?(?:robo|bot|ia|assistente)|atendimento automatico)\b/;

/** True when the AI must stay silent. "voltar ao robô" ends a pause. */
export async function isAiPaused(sessionId: string, customerJid: string, text = ""): Promise<boolean> {
  await ensureLoaded();
  const key = contactKey(sessionId, customerJid);
  const pause = pauses.get(key);
  if (!pause) return false;
  const normalized = String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (pause.until <= Date.now() || RESUME.test(normalized)) {
    pauses.delete(key);
    await persist();
    return false;
  }
  return true;
}

/** Test helper. */
export function resetHumanHandoffForTests() {
  pauses.clear();
  loaded = Promise.resolve();
}
