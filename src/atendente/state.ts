// Estado da conversa de cada cliente (por loja). Fica em memória e é salvo em
// arquivo no volume persistente, para não perder o carrinho num reinício.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Catalog } from "./catalog.js";

export type CartOption = { id: string; groupId: string; name: string; price: number; quantity: number };
export type CartItem = { productId: string; name: string; quantity: number; unitPrice: number; options: CartOption[]; notes: string };
export type Delivery =
  | { type: "pickup" }
  | { type: "delivery"; address: string; number: string; neighborhood: string; complement: string; reference: string };
export type Summary = {
  fingerprint: string; quoteToken: string; expires: number; total: number; subtotal: number; deliveryFee: number;
  text: string;
};
export type Placed = { orderId: string; orderNumber: string; at: number; draftId: string };
export type Turn = { role: "user" | "model"; text: string };

export type ConversationState = {
  draftId: string;
  items: CartItem[];
  name: string;
  delivery: Delivery | null;
  payment: string;          // pix | credit | debit | money | online_*
  changeFor: number | null; // null = não perguntado; 0 = sem troco
  summary: Summary | null;  // último resumo mostrado (o "sim" vale só para ele)
  awaitingConfirm: boolean; // a última pergunta do robô foi "Posso confirmar o seu pedido?"
  committing: boolean;
  lastPlaced: Placed | null;
  history: Turn[];
  updatedAt: number;
  greetedAt: number;
  /** Último pedido JÁ FEITO de que se falou na conversa (acompanhar, alterar). */
  placedContext: { orderNumber: string; at: number } | null;
  /** Pergunta de desambiguação pendente ("este carrinho ou o pedido Nº X?"). */
  pendingChoice: { kind: "cancel" | "add"; text: string; orderNumber: string; at: number } | null;
  /** Cliente escolhendo itens para ADICIONAR a um pedido já feito. */
  addToPlaced: { orderNumber: string; at: number; payment: string } | null;
  /** Últimos itens do carrinho já enviados para a loja acrescentar num pedido feito (evita mandar duas vezes). */
  lastReroute?: { items: string; at: number } | null;
  /** De onde veio o nome: perfil de pedidos anteriores, nome do WhatsApp ou dito pelo cliente. */
  nameSource?: "profile" | "whatsapp" | "customer";
};

export type Session = { state: ConversationState; catalog?: Catalog; catalogAt?: number };

const TTL_MS = Number(process.env.ATENDENTE_STATE_TTL_MINUTES || 180) * 60_000;
const sessions = new Map<string, Session>();
const loaded = new Set<string>();
let writes: Promise<void> = Promise.resolve();

export function freshState(): ConversationState {
  return {
    draftId: randomUUID(), items: [], name: "", delivery: null, payment: "", changeFor: null,
    summary: null, awaitingConfirm: false, committing: false, lastPlaced: null, history: [], updatedAt: Date.now(), greetedAt: 0,
    placedContext: null, pendingChoice: null, addToPlaced: null,
  };
}

function dir() {
  return process.env.ATENDENTE_STATE_DIR || join(process.env.DATA_DIR || "/data/whatsapp-sessions", "atendente");
}
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
const fileFor = (sessionId: string) => join(dir(), safe(sessionId) + ".json");

async function loadTenant(sessionId: string) {
  if (loaded.has(sessionId)) return;
  loaded.add(sessionId);
  try {
    const raw = JSON.parse(await readFile(fileFor(sessionId), "utf8"));
    for (const [customer, state] of Object.entries(raw || {})) {
      const s = state as ConversationState;
      if (s && Date.now() - Number(s.updatedAt) < TTL_MS) {
        s.committing = false;
        sessions.set(sessionId + "|" + customer, { state: { ...freshState(), ...s } });
      }
    }
  } catch { /* sem arquivo ainda */ }
}

export async function getSession(sessionId: string, customerKey: string): Promise<Session> {
  await loadTenant(sessionId);
  const key = sessionId + "|" + customerKey;
  let session = sessions.get(key);
  if (!session || Date.now() - session.state.updatedAt > TTL_MS) {
    const lastPlaced = session?.state.lastPlaced || null;
    const placedContext = session?.state.placedContext || null;
    session = { state: { ...freshState(), lastPlaced, placedContext } };
    sessions.set(key, session);
  }
  return session;
}

export function persist(sessionId: string): Promise<void> {
  const prefix = sessionId + "|";
  const snapshot: Record<string, ConversationState> = {};
  for (const [key, session] of sessions) {
    if (key.startsWith(prefix) && Date.now() - session.state.updatedAt < TTL_MS) {
      snapshot[key.slice(prefix.length)] = { ...session.state, history: session.state.history.slice(-12) };
    }
  }
  writes = writes.then(async () => {
    await mkdir(dir(), { recursive: true });
    const target = fileFor(sessionId);
    const temp = target + "." + process.pid + ".tmp";
    await writeFile(temp, JSON.stringify(snapshot), "utf8");
    await rename(temp, target);
  }).catch(() => undefined);
  return writes;
}

export function resetStateForTests() {
  sessions.clear();
  loaded.clear();
}

/** Muda sempre que o pedido muda (itens, entrega, pagamento, troco ou nome). */
export function cartFingerprint(state: ConversationState): string {
  return JSON.stringify([
    state.items.map((i) => [i.productId, i.quantity, i.notes, i.options.map((o) => [o.id, o.quantity])]),
    state.delivery, state.payment, state.payment === "money" ? state.changeFor : null, state.name.trim(),
  ]);
}
