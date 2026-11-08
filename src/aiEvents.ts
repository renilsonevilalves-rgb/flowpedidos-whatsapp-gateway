// src/aiEvents.ts
// Conversation log + store alerts for the panel "Conversas da IA".
// Batched, best-effort: logging can never delay or break a customer reply.
type Kind = "message" | "human_request" | "receipt" | "delay" | "complaint" | "manual_takeover";
type Role = "customer" | "assistant" | "store" | "system";
export type AiEvent = {
  sessionId: string; customerPhone?: string | null; customerName?: string | null;
  kind?: Kind; role: Role; body?: string; tools?: string[]; flagged?: boolean;
};

const FLUSH_MS = 2500;
const MAX_QUEUE = 400;
const queues = new Map<string, any[]>();
const phoneByJid = new Map<string, string>();
const toolsByJid = new Map<string, { tools: string[]; at: number }>();
let timer: ReturnType<typeof setTimeout> | null = null;

const enabled = () => process.env.WHATSAPP_AI_LOG !== "false" && Boolean(process.env.VERCEL_API_URL) &&
  Boolean(process.env.API_KEY || process.env.API_KEY_2);

// Replies that show the AI did not solve the customer's request.
const PROBLEM = /(pode me explicar|nao entendi|n[aã]o entendi|para n[aã]o repetir|n[aã]o consegui|tente novamente|indispon[ií]vel|n[aã]o fiz essa altera)/i;
export function isProblemReply(text: string) { return PROBLEM.test(String(text || "")); }

export function rememberCustomerPhone(sessionId: string, jid: string, phone?: string | null) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!jid || digits.length < 10) return;
  phoneByJid.set(`${sessionId}:${jid}`, digits);
  if (phoneByJid.size > 10000) phoneByJid.delete(phoneByJid.keys().next().value as string);
}

export function phoneForJid(sessionId: string, jid: string): string | null {
  const known = phoneByJid.get(`${sessionId}:${jid}`);
  if (known) return known;
  const match = /^(\d{10,15})@s\.whatsapp\.net$/.exec(String(jid || ""));
  return match ? match[1] : null;
}

/** Tools used by the AI for the next outgoing message to this customer. */
export function noteTools(sessionId: string, jid: string, tools: string[]) {
  if (tools?.length) toolsByJid.set(`${sessionId}:${jid}`, { tools: tools.slice(0, 10), at: Date.now() });
}
export function takeTools(sessionId: string, jid: string): string[] {
  const key = `${sessionId}:${jid}`;
  const entry = toolsByJid.get(key);
  toolsByJid.delete(key);
  return entry && Date.now() - entry.at < 15_000 ? entry.tools : [];
}

export function logAiEvent(event: AiEvent) {
  if (!enabled()) return;
  const phone = String(event.customerPhone || "").replace(/\D/g, "");
  if (phone.length < 10) return;
  const list = queues.get(event.sessionId) || [];
  if (list.length >= MAX_QUEUE) list.shift();
  list.push({
    customerPhone: phone,
    customerName: event.customerName || undefined,
    kind: event.kind || "message",
    role: event.role,
    body: String(event.body || "").slice(0, 2000),
    tools: event.tools || [],
    flagged: event.flagged === true || (event.role === "assistant" && isProblemReply(String(event.body || ""))),
    at: new Date().toISOString(),
  });
  queues.set(event.sessionId, list);
  // Alerts go out right away so the store is notified without delay.
  if (event.kind && event.kind !== "message") void flushAiEvents();
  else if (!timer) timer = setTimeout(() => { timer = null; void flushAiEvents(); }, FLUSH_MS);
}

export async function flushAiEvents() {
  if (timer) { clearTimeout(timer); timer = null; }
  const endpoint = String(process.env.VERCEL_API_URL || "").replace(/\/$/, "") + "/api/webhook/whatsapp/chat-order";
  const key = String(process.env.API_KEY || process.env.API_KEY_2 || "");
  const batches = [...queues.entries()];
  queues.clear();
  await Promise.all(batches.map(async ([sessionId, events]) => {
    for (let index = 0; index < events.length; index += 50) {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), 6000);
      try {
        await fetch(endpoint, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", "X-API-Key": key },
          body: JSON.stringify({ action: "ai_event", sessionId, events: events.slice(index, index + 50) }),
        });
      } catch { /* best-effort */ } finally { clearTimeout(abort); }
    }
  }));
}
