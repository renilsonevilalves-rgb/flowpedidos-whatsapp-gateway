// DIAGNÓSTICO TEMPORÁRIO de entrega (remover após achar a causa).
// Registra, para mensagens enviadas pelo robô, o ACK do servidor e os recibos
// (entregue/lido/retry) vindos do celular do cliente.
import type pino from "pino";

type Tracked = { label: string; to: string; at: number; events: any[] };
const tracked = new Map<string, Tracked>();
const attached = new WeakSet<object>();

function mask(jid: unknown) {
  const s = String(jid || "");
  return s.replace(/^(\d{4})\d+(\d{2})/, "$1***$2");
}

export function trackDiagSend(id: string | undefined | null, label: string, to: string) {
  if (!id) return;
  tracked.set(String(id), { label, to, at: Date.now(), events: [] });
  if (tracked.size > 500) tracked.delete(tracked.keys().next().value as string);
}

export function attachDeliveryDiag(sock: any, sessionId: string, logger: pino.Logger, isOwn: (id: string) => boolean = () => false) {
  const ws = sock?.ws;
  if (!ws || typeof ws.on !== "function" || attached.has(sock)) return;
  attached.add(sock);
  const record = (kind: string, node: any) => {
    const attrs = node?.attrs || {};
    const ids = [attrs.id];
    const list = Array.isArray(node?.content) ? node.content.find((c: any) => c?.tag === "list") : undefined;
    if (list && Array.isArray(list.content)) for (const item of list.content) ids.push(item?.attrs?.id);
    for (const id of ids) {
      if (id && !tracked.has(String(id)) && isOwn(String(id))) trackDiagSend(String(id), "bot", String(attrs.from || ""));
      const t = id ? tracked.get(String(id)) : undefined;
      if (!t) continue;
      const ev = { kind, type: attrs.type || (kind === "ack" ? "server" : "delivery"), error: attrs.error, from: mask(attrs.from), ms: Date.now() - t.at };
      t.events.push(ev);
      logger.info({ sessionId, messageId: id, label: t.label, to: mask(t.to), ...ev }, "[Delivery-Diag] evento");
    }
  };
  ws.on("CB:ack,class:message", (node: any) => record("ack", node));
  ws.on("CB:receipt", (node: any) => record("receipt", node));
}

export function getDiagEvents(id: string) {
  return tracked.get(String(id))?.events || [];
}

export async function inspectRecipient(sock: any, pnJid: string) {
  const out: any = { privacyTokenOn1to1: sock?.serverProps?.privacyTokenOn1to1 };
  try {
    const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(pnJid);
    out.lid = lid || null;
    for (const jid of [pnJid, lid].filter(Boolean)) {
      const tc = await sock.authState?.keys?.get?.("tctoken", [jid]);
      const entry = tc?.[jid];
      out[`tctoken_${String(jid).split("@")[1]}`] = entry?.token?.length ? { bytes: entry.token.length, ts: entry.timestamp } : null;
      try {
        const devices = await sock.getUSyncDevices?.([jid], false, false);
        out[`devices_${String(jid).split("@")[1]}`] = (devices || []).map((d: any) => mask(d.jid));
      } catch (e: any) { out[`devices_${String(jid).split("@")[1]}`] = `erro: ${e?.message}`; }
      const v = await sock.signalRepository?.validateSession?.(jid);
      out[`session_${String(jid).split("@")[1]}`] = v;
    }
  } catch (error: any) {
    out.error = error?.message || String(error);
  }
  return out;
}

// Gatilho temporário: quando o número em DELIVERY_DIAG_PHONE manda "diag", roda o teste.
export function attachDiagTrigger(sock: any, run: (digits: string) => Promise<void>) {
  const phone = String(process.env.DELIVERY_DIAG_PHONE || "").replace(/\D/g, "");
  if (!phone || !sock?.ev?.on) return;
  sock.ev.on("messages.upsert", ({ messages }: any) => {
    for (const m of messages || []) {
      if (m?.key?.fromMe) continue;
      const k = m?.key || {};
      const from = [k.remoteJidAlt, k.senderPn, k.remoteJid].map((j: any) => String(j || "").split("@")[0].split(":")[0]);
      const text = String(m?.message?.conversation || m?.message?.extendedTextMessage?.text || "").trim().toLowerCase();
      if (text === "diag" && from.some((d) => d && (d === phone || d.endsWith(phone.slice(-8))))) {
        const digits = from.find((d) => /^\d+$/.test(d) && d.length >= 12) || phone;
        void run(digits).catch(() => {});
      }
    }
  });
}
