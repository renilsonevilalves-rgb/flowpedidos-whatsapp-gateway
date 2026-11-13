// Boas práticas de envio para conta comum (conexão por QR), reduzindo o que mais
// leva a bloqueio: rajadas de mensagens, mensagens repetidas e cliente que não quer
// mais receber avisos (e acaba bloqueando/denunciando o número).
// Nada aqui disfarça o robô: só deixa o envio mais calmo e respeitoso.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MIN_GAP_MS = Number(process.env.WHATSAPP_MIN_SEND_GAP_MS || 1200);
const MAX_PER_MINUTE = Number(process.env.WHATSAPP_MAX_SENDS_PER_MINUTE || 25);
const DUPLICATE_WINDOW_MS = Number(process.env.WHATSAPP_DUPLICATE_WINDOW_MS || 120_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/\s+/g, " ").trim();
const phoneTail = (value: string) => String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "").slice(-8);

// ---------------------------------------------------------------------------
// Fila por número da loja: espaço mínimo entre envios e limite por minuto.
const queues = new Map<string, Promise<void>>();
const lastSendAt = new Map<string, number>();
const recentSends = new Map<string, number[]>();

export async function waitForSendSlot(sessionId: string): Promise<void> {
  const previous = queues.get(sessionId) || Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.then(() => mine);
  queues.set(sessionId, chain);
  await previous;
  try {
    for (;;) {
      const now = Date.now();
      const window = (recentSends.get(sessionId) || []).filter((at) => now - at < 60_000);
      recentSends.set(sessionId, window);
      const gapWait = Math.max(0, (lastSendAt.get(sessionId) || 0) + MIN_GAP_MS - now);
      const rateWait = window.length >= MAX_PER_MINUTE ? 60_000 - (now - window[0]) + 50 : 0;
      const wait = Math.max(gapWait, rateWait);
      if (wait <= 0) break;
      await sleep(Math.min(wait, 60_000));
    }
    const at = Date.now();
    lastSendAt.set(sessionId, at);
    recentSends.get(sessionId)!.push(at);
  } finally {
    release();
    if (queues.get(sessionId) === chain) void chain.then(() => { if (queues.get(sessionId) === chain) queues.delete(sessionId); });
  }
}

// ---------------------------------------------------------------------------
// Mesma mensagem para o mesmo cliente em poucos minutos, sem ele ter escrito nada
// no meio (ex.: aviso disparado duas vezes): não manda de novo.
const lastTexts = new Map<string, number>();

/** true = repetida (não enviar). Registra o envio quando não é repetida. */
export function isDuplicateSend(sessionId: string, jid: string, text: string, lastCustomerMessageAt = 0, now = Date.now()): boolean {
  const body = norm(text);
  if (!body) return false;
  const key = sessionId + "|" + phoneTail(jid) + "|" + body;
  const last = lastTexts.get(key);
  if (last && now - last < DUPLICATE_WINDOW_MS && lastCustomerMessageAt <= last) return true;
  lastTexts.set(key, now);
  if (lastTexts.size > 20000) lastTexts.delete(lastTexts.keys().next().value as string);
  return false;
}

// ---------------------------------------------------------------------------
// Cliente que pediu para não receber avisos automáticos (fica salvo no volume).
const optedOut = new Set<string>();
let optOutLoaded = false;
const optOutFile = () => join(process.env.DATA_DIR || "/data/whatsapp-sessions", "opt-out.json");

async function loadOptOut() {
  if (optOutLoaded) return;
  optOutLoaded = true;
  try {
    const list = JSON.parse(await readFile(optOutFile(), "utf8"));
    if (Array.isArray(list)) for (const key of list) if (typeof key === "string") optedOut.add(key);
  } catch { /* sem arquivo ainda */ }
}

async function saveOptOut() {
  try {
    await mkdir(join(optOutFile(), ".."), { recursive: true });
    const temp = optOutFile() + "." + process.pid + ".tmp";
    await writeFile(temp, JSON.stringify([...optedOut]), "utf8");
    await rename(temp, optOutFile());
  } catch { /* melhor esforço */ }
}

/** Mensagem inteira pedindo para parar de receber ("parar", "não quero mais receber mensagens"). */
export function isOptOutRequest(text: string): boolean {
  const t = norm(text).replace(/[.!]+$/, "");
  return /^(?:parar|pare|stop|sair|descadastrar|nao quero (?:mais )?receber(?: mensage(?:m|ns)| avisos)?|para de (?:me )?mandar mensage(?:m|ns)|nao me mande mais mensage(?:m|ns))$/.test(t);
}

/** "voltar", "quero receber de novo", "ativar avisos". */
export function isOptInRequest(text: string): boolean {
  return /^(?:voltar|voltar a receber|quero receber(?: de novo)?|ativar(?: avisos)?|receber avisos)$/.test(norm(text).replace(/[.!]+$/, ""));
}

export async function setOptOut(sessionId: string, phone: string, out: boolean) {
  await loadOptOut();
  const key = sessionId + "|" + phoneTail(phone);
  if (phoneTail(phone).length < 8) return;
  if (out) optedOut.add(key); else optedOut.delete(key);
  await saveOptOut();
}

export async function hasOptedOut(sessionId: string, phone: string): Promise<boolean> {
  await loadOptOut();
  const tail = phoneTail(phone);
  return tail.length >= 8 && optedOut.has(sessionId + "|" + tail);
}

export function resetSendHygieneForTests() {
  queues.clear(); lastSendAt.clear(); recentSends.clear(); lastTexts.clear(); optedOut.clear(); optOutLoaded = true;
}
