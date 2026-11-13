import "dotenv/config";

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import QRCode from "qrcode";
import pino from "pino";
import { rm } from "node:fs/promises";
import { describeIncomingImage, hasAudio, hasImage, transcribeIncomingAudio } from "./audioTranscription.js";
import { isAiPaused, pauseAi } from "./humanHandoff.js";
import { flushAiEvents, logAiEvent, phoneForJid, rememberCustomerPhone, takeTools } from "./aiEvents.js";
import { usesCentralAgent } from "./chatOrder.js";
import { applyPeriodGreeting, isGreetingMessage, periodGreeting } from "./greeting.js";
import { showTypingThenWait } from "./naturalPacing.js";
import { hasOptedOut, isDuplicateSend, isOptInRequest, isOptOutRequest, setOptOut, waitForSendSlot } from "./sendHygiene.js";
import { handleAtendenteMessage, isAtendenteTenant, noteOrderContext, noteOutboundOrderMessage } from "./atendente/engine.js";
import * as legacyOrderAi from "./aiAssistant.js";
import * as legacyOrderAiV2 from "./aiAssistantV2.js";
import { join } from "node:path";
import {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || "";
const API_KEY_2 = process.env.API_KEY_2 || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "";
const DATA_DIR = process.env.DATA_DIR || "/data/whatsapp-sessions";
const VERCEL_API_URL = (process.env.VERCEL_API_URL || "").replace(/\/$/, "");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const allowedOrigins = FRONTEND_URL
  ? FRONTEND_URL.split(",").map((v) => v.trim()).filter(Boolean)
  : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-API-Key"],
}));

type SessionStatus = "starting" | "qr" | "connected" | "disconnected" | "logged_out" | "error";
type Session = {
  id: string;
  status: SessionStatus;
  qr?: string;
  qrDataUrl?: string;
  phone?: string;
  sock?: WASocket;
  starting?: Promise<void>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, Session>();
const processedMessages = new Set<string>();
const userLastReply = new Map<string, number>();
const replyInFlight = new Set<string>();
const manualLogouts = new Set<string>();
const pairingRequestsInFlight = new Set<string>();

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY && !API_KEY_2) {
    res.status(500).json({ error: "API_KEY is not configured on the gateway." });
    return;
  }
  const provided = req.header("X-API-Key");
  if (!provided || (provided !== API_KEY && provided !== API_KEY_2)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function safeSessionId(value: string) {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function getOrCreateSession(id: string): Session {
  let session = sessions.get(id);
  if (!session) {
    session = { id, status: "disconnected" };
    sessions.set(id, session);
  }
  return session;
}

function authPathFor(id: string) {
  return join(DATA_DIR, id);
}

async function clearAuthState(id: string) {
  try {
    await rm(authPathFor(id), { recursive: true, force: true });
    logger.info({ sessionId: id }, "WhatsApp auth state cleared");
  } catch (error) {
    logger.error({ error, sessionId: id }, "Failed to clear WhatsApp auth state");
  }
}

async function resolveWhatsAppWebVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const result = await fetchLatestWaWebVersion({ signal: controller.signal });
    if (result?.version?.length === 3) {
      logger.info({ version: result.version.join(".") }, "Using live WhatsApp Web version");
      return result.version;
    }
    logger.warn({ result }, "Live WhatsApp Web version was not available; using Baileys default");
  } catch (error) {
    logger.warn({ error }, "Could not resolve live WhatsApp Web version; using Baileys default");
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}

function scheduleReconnect(id: string, fresh = false, delayMs = 1500) {
  const session = getOrCreateSession(id);
  if (manualLogouts.has(id) || session.reconnectTimer) return;
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = undefined;
    void connectSession(id, fresh).catch((error) => {
      session.status = "error";
      logger.error({ error, sessionId: id }, "Reconnect failed");
    });
  }, delayMs);
}

async function waitForQrOrConnected(id: string, timeoutMs = 10000) {
  const session = getOrCreateSession(id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.status === "qr" || session.status === "connected" || session.status === "error") return session.status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return session.status;
}

async function fetchStoreInfo(sessionId: string) {
  const baseUrls = [VERCEL_API_URL, "https://flowoficial01.vercel.app"]
    .map((value) => value.replace(/\/$/, ""))
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
  const keys = [API_KEY, API_KEY_2]
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
  if (!baseUrls.length) throw new Error("No Vercel API URL is configured on the gateway");
  if (!keys.length) throw new Error("No gateway API key is configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    let lastError: Error | undefined;

    for (const baseUrl of baseUrls) {
      for (const key of keys) {
        try {
          const response = await fetch(`${baseUrl}/api/webhook/whatsapp/store-info`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": key },
            body: JSON.stringify({ sessionId }),
            signal: controller.signal,
          });
          const data = await response.json().catch(() => ({}));

          if (response.ok) return data;

          lastError = new Error(`Vercel store-info returned HTTP ${response.status}: ${data?.error || "unknown error"}`);
          logger.warn({ sessionId, status: response.status, keySlot: key === API_KEY ? "API_KEY" : "API_KEY_2", baseUrl }, "[Auto-Reply] store-info request failed");

          if (response.status !== 401 && response.status < 500) break;
        } catch (error: any) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }

      if (lastError?.message.includes("HTTP 400") || lastError?.message.includes("HTTP 404")) break;
    }

    throw lastError || new Error("Vercel store-info request failed");
  } finally {
    clearTimeout(timer);
  }
}

function unwrapMessage(message: any): any {
  let current = message;
  for (let i = 0; i < 6 && current; i += 1) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }
  return current || {};
}

function extractMessageText(message: any) {
  const unwrapped = unwrapMessage(message);
  return unwrapped?.conversation ||
    unwrapped?.extendedTextMessage?.text ||
    unwrapped?.imageMessage?.caption ||
    unwrapped?.videoMessage?.caption ||
    unwrapped?.documentMessage?.caption ||
    "";
}

function getCustomerJid(msg: any, remoteJid: string) {
  return [
    msg?.key?.remoteJidAlt,
    msg?.key?.senderPn,
    msg?.key?.participantPn,
    remoteJid,
  ].find((value: unknown) => typeof value === "string" && /@s\.whatsapp\.net$/.test(value)) ||
    msg?.key?.remoteJidAlt ||
    msg?.key?.senderPn ||
    msg?.key?.participantPn ||
    remoteJid;
}

function isTrackOrderTrigger(text: string) {
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return /^(acompanhar\s+pedido|acompanhar\s+meu\s+pedido|status\s+do\s+pedido|rastrear\s+pedido)[!,.?\s]*$/i.test(normalized);
}

async function fetchOrderStatus(sessionId: string, phone: string) {
  if (!VERCEL_API_URL) throw new Error("VERCEL_API_URL is not configured on the gateway");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${VERCEL_API_URL}/api/webhook/whatsapp/order-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({ sessionId, phone }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `Order-status returned HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

function isAutoReplyTrigger(text: string) {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  if (!normalized) return false;

  const greetingOnly = /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem)[!,.?\s]*$/i;
  if (greetingOnly.test(normalized)) return true;
  if (isGreetingMessage(text)) return true;

  const explicitRequest = /\b(cardapio|menu|fazer\s+um\s+pedido|quero\s+(pedir|fazer\s+um\s+pedido)|gostaria\s+de\s+(pedir|ver\s+o\s+cardapio)|como\s+fac(o|a)\s+um\s+pedido)\b/i;
  return explicitRequest.test(normalized);
}

// ---------------------------------------------------------------------------
// Manual takeover: when the store answers a customer from the phone, the AI
// pauses for that customer. Messages sent by this gateway are told apart by
// their IDs; WhatsApp Business auto-replies (seconds after the customer
// message) are ignored.
const MANUAL_PAUSE_MINUTES = Number(process.env.WHATSAPP_MANUAL_PAUSE_MINUTES || 30);
const ownSentIds = new Set<string>();
const lastCustomerMessageAt = new Map<string, number>();
const trackedSockets = new WeakSet<object>();

// Mensagens enviadas recentemente, para atender pedidos de reenvio (retry) do WhatsApp.
const sentMessageCache = new Map<string, { message: any; at: number }>();
const SENT_CACHE_MS = 30 * 60 * 1000;

function rememberSentMessage(sent: any) {
  const id = sent?.key?.id;
  if (!id || !sent?.message) return;
  sentMessageCache.set(String(id), { message: sent.message, at: Date.now() });
  if (sentMessageCache.size > 5000) sentMessageCache.delete(sentMessageCache.keys().next().value as string);
}

function getCachedSentMessage(key: any) {
  const id = key?.id ? String(key.id) : "";
  const cached = id ? sentMessageCache.get(id) : undefined;
  if (!cached) return undefined;
  if (Date.now() - cached.at > SENT_CACHE_MS) { sentMessageCache.delete(id); return undefined; }
  return cached.message;
}

function rememberOwnSend(messageId: unknown) {
  if (!messageId) return;
  ownSentIds.add(String(messageId));
  if (ownSentIds.size > 20000) ownSentIds.delete(ownSentIds.values().next().value as string);
}

function trackOwnSends(sessionId: string, sock: WASocket) {
  if (!sock || typeof (sock as any).sendMessage !== "function" || trackedSockets.has(sock as any)) return;
  trackedSockets.add(sock as any);
  // Diagnóstico de entrega das mensagens do robô (2 = servidor, 3 = entregue, 4 = lida, 0 = erro).
  try {
    (sock as any).ev?.on?.("messages.update", (updates: any[]) => {
      for (const item of updates || []) {
        const id = String(item?.key?.id || "");
        const status = item?.update?.status;
        if (!id || status === undefined || !ownSentIds.has(id)) continue;
        if (status === 0) logger.warn({ sessionId, messageId: id }, "[Delivery] WhatsApp recusou a mensagem do robô");
        else if (status === 3) logger.info({ sessionId, messageId: id }, "[Delivery] Mensagem do robô entregue");
      }
    });
  } catch {}
  const original = (sock as any).sendMessage.bind(sock);
  (sock as any).sendMessage = async (jid: string, content: any, options?: any) => {
    // Respostas a um cliente que escreveu há pouco mostram "digitando..." antes de sair.
    // Notificações avulsas (/send) para quem não está conversando seguem sem atraso.
    const pacedText = typeof content?.text === "string" ? content.text : "";
    // Sem repetição e sem rajada: mesma mensagem duplicada é descartada e os envios saem em fila.
    // (Guardado: testes isolados carregam este wrapper sem o módulo de boas práticas.)
    if (typeof isDuplicateSend === "function" && pacedText && typeof jid === "string"
      && isDuplicateSend(sessionId, jid, pacedText, lastCustomerMessageAt.get(`${sessionId}:${jid}`) || 0)) {
      logger.info({ sessionId }, "[Outbound] Mensagem repetida descartada");
      return undefined;
    }
    if (typeof waitForSendSlot === "function") await waitForSendSlot(sessionId);
    if (pacedText && typeof jid === "string" && !jid.endsWith("@g.us")
      && Date.now() - (lastCustomerMessageAt.get(`${sessionId}:${jid}`) || 0) < 10 * 60 * 1000) {
      await showTypingThenWait(sock, jid, pacedText);
    }
    const sent = await original(jid, content, options);
    rememberOwnSend(sent?.key?.id);
    // Guarded: isolated handoff tests load this wrapper without the cache helper.
    if (typeof rememberSentMessage === "function") rememberSentMessage(sent);
    const text = typeof content?.text === "string" ? content.text : "";
    if (text && typeof jid === "string" && !jid.endsWith("@g.us")) {
      logAiEvent({ sessionId, customerPhone: phoneForJid(sessionId, jid), role: "assistant", body: text, tools: takeTools(sessionId, jid) });
    }
    return sent;
  };
}

function hasRealContent(message: any) {
  const unwrapped = unwrapMessage(message) || {};
  return Boolean(extractMessageText(message) || unwrapped.imageMessage || unwrapped.audioMessage ||
    unwrapped.videoMessage || unwrapped.documentMessage || unwrapped.stickerMessage || unwrapped.locationMessage);
}

function handleStoreOwnMessage(sessionId: string, msg: any) {
  if (process.env.WHATSAPP_MANUAL_TAKEOVER === "false") return;
  const remoteJid = String(msg?.key?.remoteJid || "");
  if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us") || remoteJid.endsWith("@newsletter")) return;
  if (!hasRealContent(msg.message)) return;
  const messageId = String(msg?.key?.id || "");
  // sendMessage resolves after Baileys emits the echo; check after a short delay.
  setTimeout(() => {
    if (messageId && ownSentIds.has(messageId)) return;
    const customerJid = getCustomerJid(msg, remoteJid);
    const lastCustomer = Math.max(lastCustomerMessageAt.get(`${sessionId}:${customerJid}`) || 0,
      lastCustomerMessageAt.get(`${sessionId}:${remoteJid}`) || 0);
    if (Date.now() - lastCustomer < 8000) return; // WhatsApp Business greeting/away message
    void pauseAi(sessionId, customerJid, MANUAL_PAUSE_MINUTES, "manual_reply");
    if (remoteJid !== customerJid) void pauseAi(sessionId, remoteJid, MANUAL_PAUSE_MINUTES, "manual_reply");
    logAiEvent({ sessionId, customerPhone: phoneForJid(sessionId, customerJid) || phoneForJid(sessionId, remoteJid),
      kind: "manual_takeover", role: "store", body: extractMessageText(msg.message) || "[mídia enviada pela loja]" });
    logger.info({ sessionId }, "[Handoff] Store replied manually; AI paused for this customer");
  }, 2500);
}

async function handleIncomingMessages(id: string, sock: WASocket, messages: any[], type: string) {
  trackOwnSends(id, sock);
  if (type !== "notify") return;

  for (const msg of messages) {
    try {
      if (!msg.message) continue;
      if (msg.key.fromMe) { handleStoreOwnMessage(id, msg); continue; }
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us")) continue;

      if (msg.key.id) {
        if (processedMessages.has(msg.key.id)) continue;
        processedMessages.add(msg.key.id);
        if (processedMessages.size > 5000) {
          const first = processedMessages.values().next().value;
          if (first) processedMessages.delete(first);
        }
      }

      let text = extractMessageText(msg.message).trim();
      if (!text && hasAudio(msg.message) && process.env.GEMINI_API_KEY && process.env.WHATSAPP_AUDIO_TRANSCRIPTION !== "false") {
        const heard = await transcribeIncomingAudio(msg, logger, id);
        if (heard) text = heard;
        else {
          await sock.sendMessage(remoteJid, { text: "Não consegui ouvir seu áudio direitinho 😅 Pode me mandar por escrito?" }).catch(() => undefined);
          continue;
        }
      }
      // Localização (pino do mapa) no atendente de pedidos: vira texto para a IA pedir rua, número e bairro.
      if (!text && isAtendenteTenant(id)) {
        const location = unwrapMessage(msg.message)?.locationMessage || unwrapMessage(msg.message)?.liveLocationMessage;
        if (location) {
          const place = [location.name, location.address].filter((v: unknown) => typeof v === "string" && v.trim()).join(" - ").slice(0, 200);
          text = "[Cliente enviou a localização pelo mapa" + (place ? ": " + place : "") + "]";
        }
      }
      // Photos (receipts, menu prints) for stores with the central AI.
      if (hasImage(msg.message) && usesCentralAgent(id) && process.env.GEMINI_API_KEY) {
        const seen = await describeIncomingImage(msg, logger, id);
        if (seen) text = [text, seen].filter(Boolean).join("\n");
      }
      if (!text) continue;

      logger.info({ sessionId: id, remoteJid, text }, "[Incoming] WhatsApp message received");

      // Conversation log, manual/human pause and per-customer timing.
      {
        const pauseJid = getCustomerJid(msg, remoteJid);
        const pausePhone = await resolveCustomerPhone(sock, msg, remoteJid);
        rememberCustomerPhone(id, pauseJid, pausePhone);
        rememberCustomerPhone(id, remoteJid, pausePhone);
        lastCustomerMessageAt.set(`${id}:${pauseJid}`, Date.now());
        lastCustomerMessageAt.set(`${id}:${remoteJid}`, Date.now());
        if (lastCustomerMessageAt.size > 20000) lastCustomerMessageAt.delete(lastCustomerMessageAt.keys().next().value as string);
        const customerName = typeof msg.pushName === "string" ? msg.pushName.slice(0, 120) : null;
        logAiEvent({ sessionId: id, customerPhone: pausePhone, customerName, role: "customer", body: text });
        // Marca como lida (como uma pessoa faria ao abrir a conversa).
        if (process.env.WHATSAPP_READ_RECEIPTS !== "false") void Promise.resolve().then(() => sock.readMessages([msg.key])).catch(() => undefined);
        // "Parar": não manda mais avisos automáticos para este cliente; "voltar" religa.
        if (isOptOutRequest(text) || isOptInRequest(text)) {
          const optOut = isOptOutRequest(text);
          await setOptOut(id, pausePhone || pauseJid, optOut);
          await sock.sendMessage(pauseJid, { text: optOut
            ? "Pronto, não vou mais te mandar avisos automáticos 👍 Se quiser voltar a receber, é só mandar *voltar*."
            : "Pronto, você voltou a receber os avisos dos seus pedidos por aqui ✅" }).catch(() => undefined);
          continue;
        }
        if (await isAiPaused(id, pauseJid, text) || (remoteJid !== pauseJid && await isAiPaused(id, remoteJid, text))) {
          logger.info({ sessionId: id }, "[Handoff] Human attendance active; automatic reply skipped");
          continue;
        }
      }

      const isTrackingTrigger = isTrackOrderTrigger(text);
      if (isTrackingTrigger) {
        try {
          const customerJid = getCustomerJid(msg, remoteJid);
          const customerPhone = customerJid.split("@")[0].split(":")[0];
          const result = await fetchOrderStatus(id, customerPhone);
          await sock.sendMessage(customerJid, { text: result.message });
          if (isAtendenteTenant(id)) void noteOrderContext(id, customerJid, String(result.orderNumber || "")).catch(() => undefined);
          logger.info({ sessionId: id, remoteJid: customerJid, orderId: result.orderId }, "[Order-Tracking] Status enviado com sucesso");
        } catch (error: any) {
          logger.error({ error: error?.message || error, sessionId: id, remoteJid }, "[Order-Tracking] Falha ao consultar/enviar status");
          const customerJid = getCustomerJid(msg, remoteJid);
          await sock.sendMessage(customerJid, { text: "Não consegui localizar seu pedido agora. Verifique se o pedido foi feito com este mesmo número de WhatsApp e tente novamente. 🙏" }).catch(() => undefined);
        }
        continue;
      }

      // Atendente de pedidos pela conversa: só lojas em WHATSAPP_AI_ORDER_TENANTS.
      // Pedidos já feitos (acompanhar/alterar/cancelar) seguem no fluxo atual.
      if (isAtendenteTenant(id)) {
        const atendenteJid = getCustomerJid(msg, remoteJid);
        const atendenteHandled = await handleAtendenteMessage({
          sessionId: id, customerJid: atendenteJid, text,
          customerPhone: await resolveCustomerPhone(sock, msg, remoteJid),
          customerName: typeof msg.pushName === "string" ? msg.pushName : null,
          legacyBusy: legacyOrderAi.hasPendingOrderCancellation(id, atendenteJid) ||
            legacyOrderAi.hasPendingOrderAction(id, atendenteJid) || legacyOrderAiV2.hasPendingOrderChange(id, atendenteJid),
          sendMessage: async (reply) => { await sock.sendMessage(atendenteJid, { text: reply }); },
          pauseForHuman: async () => {
            await pauseAi(id, atendenteJid, Number(process.env.WHATSAPP_HUMAN_PAUSE_MINUTES || 120), "customer_request");
            logAiEvent({ sessionId: id, customerPhone: phoneForJid(id, atendenteJid), kind: "human_request", role: "system", body: "Cliente pediu atendente" });
          },
          periodGreeting: () => periodGreeting(),
          logger,
        }).catch((error: any) => {
          logger.warn({ sessionId: id, error: error?.message || error }, "[Atendente] Falha; seguindo fluxo atual");
          return false;
        });
        if (atendenteHandled === true) continue;
        // Assunto de pedido já feito: segue o fluxo atual com o texto preparado pelo atendente.
        if (typeof atendenteHandled === "string" && atendenteHandled) text = atendenteHandled;
      }

      const isTrigger = isAutoReplyTrigger(text);
      if (!isTrigger) continue;

      const customerJid = getCustomerJid(msg, remoteJid);
      const userKey = `${id}-${customerJid}`;
      const lastReplyTime = userLastReply.get(userKey) || 0;
      const fourHours = 1000 * 60 * 60 * 4;

      if (Date.now() - lastReplyTime <= fourHours) {
        logger.info({ sessionId: id, remoteJid: customerJid }, "[Auto-Reply] 4-hour cooldown active; message ignored");
        continue;
      }

      if (replyInFlight.has(userKey)) {
        logger.info({ sessionId: id, remoteJid: customerJid }, "[Auto-Reply] Reply already in flight; duplicate event ignored");
        continue;
      }

      replyInFlight.add(userKey);

      try {
        const storeInfo = await fetchStoreInfo(id);
        if (!storeInfo?.menuUrl) {
          logger.warn({ sessionId: id, remoteJid: customerJid, storeInfo }, "[Auto-Reply] Store has no menuUrl");
          continue;
        }

        let replyText = storeInfo.autoReplyMessage;
        if (!replyText) {
          replyText = `Olá! 👋 Seja bem-vindo a (*${storeInfo.storeName || "Nome da Loja"}*)\n\nConfira nosso cardápio e faça seu pedido por aqui: ${storeInfo.menuUrl}\n\nÉ só escolher os produtos e finalizar seu pedido. 😊\n\n_(Este é um atendimento automático)_`;
        } else if (replyText.includes("{link}")) {
          replyText = replyText.replace(/\{link\}/g, storeInfo.menuUrl);
        } else if (!replyText.includes(storeInfo.menuUrl)) {
          replyText = `${replyText}\n\n${storeInfo.menuUrl}`;
        }

        await sock.sendMessage(customerJid, { text: replyText });
        userLastReply.set(userKey, Date.now());
        logger.info({ sessionId: id, remoteJid: customerJid, menuUrl: storeInfo.menuUrl }, "[Auto-Reply] Resposta enviada com sucesso");
      } catch (error: any) {
        logger.error({ error: error?.message || error, sessionId: id, remoteJid: customerJid }, "[Auto-Reply] Falha ao buscar/enviar cardápio; retry liberado");
      } finally {
        replyInFlight.delete(userKey);
      }
    } catch (error: any) {
      logger.error({ error: error?.message || error, sessionId: id }, "[Auto-Reply] Erro ao processar mensagem");
    }
  }
}

async function connectSession(id: string, forceFresh = false): Promise<void> {
  const session = getOrCreateSession(id);
  if (session.starting) return session.starting;
  if (session.status === "connected" && session.sock) return;
  if (forceFresh) await clearAuthState(id);

  session.status = "starting";
  session.qr = undefined;
  session.qrDataUrl = undefined;
  session.phone = undefined;

  session.starting = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(authPathFor(id));
    const version = await resolveWhatsAppWebVersion();
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      qrTimeout: 60000,
      logger: logger.child({ sessionId: id }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: (jid) => jid === "status@broadcast",
      // Quando o celular do cliente não consegue abrir a mensagem (sessão de
      // criptografia nova, ex.: logo após reconectar), ele pede reenvio. Sem
      // getMessage o reenvio falha e a mensagem some sem erro.
      getMessage: async (key: any) => getCachedSentMessage(key),
    });

    session.sock = sock;
    // Guarded: isolated lifecycle tests load this function without the helper.
    if (typeof trackOwnSends === "function") trackOwnSends(id, sock);
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      await handleIncomingMessages(id, sock, messages, type);
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          session.status = "qr";
          session.qr = qr;
          session.qrDataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 2, width: 420 });
          logger.info({ sessionId: id }, "QR code generated");
        } catch (error) {
          session.status = "error";
          logger.error({ error, sessionId: id }, "Failed to generate QR data URL");
        }
      }
      if (connection === "open") {
        session.status = "connected";
        session.qr = undefined;
        session.qrDataUrl = undefined;
        session.phone = sock.user?.id?.split(":")[0];
        logger.info({ sessionId: id, phone: session.phone }, "WhatsApp connected");
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const badSession = statusCode === DisconnectReason.badSession;
        const manuallyLoggedOut = manualLogouts.has(id);
        session.sock = undefined;
        session.qr = undefined;
        session.qrDataUrl = undefined;
        session.phone = undefined;
        if (manuallyLoggedOut) {
          manualLogouts.delete(id);
          session.status = "logged_out";
          return;
        }
        if (loggedOut || badSession) {
          session.status = "disconnected";
          await clearAuthState(id);
          scheduleReconnect(id, true, 1000);
          return;
        }
        session.status = "disconnected";
        scheduleReconnect(id, false, 3000);
      }
    });
  })();

  try { await session.starting; } finally { session.starting = undefined; }
}

async function startSessionWithRecovery(id: string) {
  const session = getOrCreateSession(id);
  if (session.status === "connected" && session.sock) return;
  await connectSession(id, session.status === "logged_out");
  let status = await waitForQrOrConnected(id, 10000);
  if (status === "starting" || status === "disconnected") {
    if (session.sock) { try { session.sock.end(undefined); } catch {} session.sock = undefined; }
    if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = undefined; }
    await clearAuthState(id);
    session.status = "disconnected";
    await connectSession(id, true);
    status = await waitForQrOrConnected(id, 10000);
  }
  if (status === "error") throw new Error("Could not initialize WhatsApp session");
}

async function logoutSession(id: string) {
  const session = sessions.get(id);
  if (!session) { await clearAuthState(id); return; }
  manualLogouts.add(id);
  if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = undefined; }
  try { await session.sock?.logout(); } catch (error) { logger.warn({ error, sessionId: id }, "WhatsApp logout returned an error"); }
  session.sock = undefined;
  session.qr = undefined;
  session.qrDataUrl = undefined;
  session.phone = undefined;
  session.status = "logged_out";
  await clearAuthState(id);
}

function normalizeRecipientPhone(value: unknown) {
  const raw = String(value || "").replace(/\D/g, "");
  if (!raw) return null;
  if (raw.startsWith("55") && (raw.length === 12 || raw.length === 13)) return raw;
  if (raw.length === 10 || raw.length === 11) return `55${raw}`;
  return null;
}

// Uma tentativa de pareamento que falhou (QR/código expirado) deixa credenciais
// pela metade no disco. Reaproveitá-las faz o próximo QR/código falhar ou entrar em
// loop. Só descarta quando a sessão terminou em erro, sem socket ativo e NUNCA foi
// registrada — uma loja já conectada de verdade nunca é apagada aqui.
async function discardUnfinishedPairing(id: string) {
  const session = getOrCreateSession(id);
  if (session.status !== "error" || session.sock || session.starting || session.loggingOut) return;
  try {
    const { readFile } = await import("node:fs/promises");
    const creds = JSON.parse(await readFile(join(authPathFor(id), "creds.json"), "utf8"));
    if (creds?.registered === true) return;
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    logger.warn({ sessionId: id }, "Could not inspect unfinished pairing credentials; keeping them");
    return;
  }
  await clearAuthState(id);
  logger.info({ sessionId: id }, "Discarded unfinished pairing credentials before a new attempt");
}

function normalizePairingPhone(value: unknown) {
  const raw = String(value || "").replace(/\D/g, "");
  if (!raw) return null;
  if (raw.length === 10 || raw.length === 11) return `55${raw}`;
  if (raw.length >= 11 && raw.length <= 15) return raw;
  return null;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "flowpedidos-whatsapp-gateway", uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() }));

app.get("/session/:sessionId/status", authMiddleware, (req, res) => {
  const sessionId = req.params.sessionId as string;
  if (!safeSessionId(sessionId)) { res.status(400).json({ error: "Invalid sessionId" }); return; }
  const session = getOrCreateSession(sessionId);
  res.json({ id: session.id, status: session.status, phone: session.phone || null, hasQr: Boolean(session.qrDataUrl) });
});

app.post("/session/:sessionId/start", authMiddleware, async (req, res) => {
  const sessionId = req.params.sessionId as string;
  if (!safeSessionId(sessionId)) { res.status(400).json({ error: "Invalid sessionId" }); return; }
  try {
    await discardUnfinishedPairing(sessionId);
    await startSessionWithRecovery(sessionId);
    const session = getOrCreateSession(sessionId);
    res.json({ ok: true, id: session.id, status: session.status, phone: session.phone || null, hasQr: Boolean(session.qrDataUrl) });
  } catch (error: any) {
    const session = getOrCreateSession(sessionId);
    session.status = "error";
    logger.error({ error: error?.message || error, sessionId }, "Could not start session");
    res.status(500).json({ ok: false, error: "Could not start WhatsApp session" });
  }
});

app.post("/session/:sessionId/pairing-code", authMiddleware, async (req, res) => {
  const sessionId = req.params.sessionId as string;
  if (!safeSessionId(sessionId)) { res.status(400).json({ ok: false, error: "Invalid sessionId" }); return; }

  const phone = normalizePairingPhone(req.body?.phone);
  if (!phone) {
    res.status(400).json({ ok: false, error: "Informe um número de WhatsApp válido com DDD e, se necessário, código do país." });
    return;
  }

  const session = getOrCreateSession(sessionId);
  if (session.status === "connected" && session.sock) {
    res.status(409).json({ ok: false, error: "O WhatsApp desta loja já está conectado." });
    return;
  }
  if (pairingRequestsInFlight.has(sessionId)) {
    res.status(409).json({ ok: false, error: "Já existe uma solicitação de código de pareamento em andamento." });
    return;
  }

  pairingRequestsInFlight.add(sessionId);
  try {
    // Um QR antigo (aberto e abandonado) pode expirar em segundos e levar o código
    // junto. Como a loja ainda não está pareada, começa uma conexão limpa para o
    // código ter a validade inteira.
    if (session.sock && session.status === "qr" && !(session.sock as any).authState?.creds?.registered) {
      await logoutSession(sessionId);
    }
    await discardUnfinishedPairing(sessionId);
    await startSessionWithRecovery(sessionId);
    const activeSession = getOrCreateSession(sessionId);

    if (activeSession.status === "connected" && activeSession.sock) {
      res.status(409).json({ ok: false, error: "O WhatsApp desta loja já está conectado." });
      return;
    }
    if (!activeSession.sock) {
      res.status(503).json({ ok: false, error: "A sessão do WhatsApp ainda não está pronta para gerar o código." });
      return;
    }

    const code = await activeSession.sock.requestPairingCode(phone);
    const normalizedCode = String(code || "").replace(/\s+/g, "").trim();
    if (!normalizedCode) throw new Error("WhatsApp did not return a pairing code");

    logger.info({ sessionId, phoneSuffix: phone.slice(-4) }, "Pairing code generated");
    res.json({ ok: true, code: normalizedCode, status: activeSession.status });
  } catch (error: any) {
    logger.error({ error: error?.message || error, sessionId }, "Failed to generate pairing code");
    res.status(502).json({ ok: false, error: "Não foi possível gerar o código de pareamento agora. Tente novamente em alguns segundos." });
  } finally {
    pairingRequestsInFlight.delete(sessionId);
  }
});

app.post("/session/:sessionId/send", authMiddleware, async (req, res) => {
  const sessionId = req.params.sessionId as string;
  if (!safeSessionId(sessionId)) { res.status(400).json({ ok: false, error: "Invalid sessionId" }); return; }

  const phone = normalizeRecipientPhone(req.body?.phone);
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

  if (!phone) {
    res.status(400).json({ ok: false, error: "Telefone do cliente inválido." });
    return;
  }
  if (!text) {
    res.status(400).json({ ok: false, error: "Mensagem vazia." });
    return;
  }
  if (text.length > 12000) {
    res.status(400).json({ ok: false, error: "Mensagem muito longa." });
    return;
  }

  const session = getOrCreateSession(sessionId);
  if (session.status !== "connected" || !session.sock) {
    res.status(409).json({ ok: false, error: "O WhatsApp da loja não está conectado.", status: session.status });
    return;
  }

  // Cliente que mandou "parar" não recebe avisos automáticos.
  if (await hasOptedOut(sessionId, phone)) {
    logger.info({ sessionId }, "[Outbound] Cliente pediu para não receber avisos; envio ignorado");
    res.json({ ok: true, sent: false, skipped: "opt_out", phone });
    return;
  }
  // Avisos avulsos também passam pela fila (sem rajada) e pela proteção contra repetição.
  trackOwnSends(sessionId, session.sock as WASocket);

  try {
    await session.sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
    logger.info({ sessionId, phone }, "[Outbound] Mensagem enviada com sucesso");
    res.json({ ok: true, phone });
    // Aviso de pedido da loja: o atendente passa a saber de qual pedido o cliente vai falar.
    try { noteOutboundOrderMessage(sessionId, phone, text); } catch { /* opcional */ }
  } catch (error: any) {
    logger.error({ error: error?.message || error, sessionId, phone }, "[Outbound] Falha ao enviar mensagem");
    res.status(502).json({ ok: false, error: "Não foi possível enviar a mensagem pelo WhatsApp." });
  }
});

app.get("/session/:sessionId/qr", authMiddleware, (req, res) => {
  const sessionId = req.params.sessionId as string;
  if (!safeSessionId(sessionId)) { res.status(400).json({ error: "Invalid sessionId" }); return; }
  const session = getOrCreateSession(sessionId);
  if (!session.qrDataUrl) { res.status(404).json({ ok: false, error: "QR code not available", status: session.status }); return; }
  res.json({ ok: true, status: session.status, qrDataUrl: session.qrDataUrl });
});

app.post("/session/:sessionId/logout", authMiddleware, async (req, res) => {
  const sessionId = req.params.sessionId as string;
  if (!safeSessionId(sessionId)) { res.status(400).json({ error: "Invalid sessionId" }); return; }
  await logoutSession(sessionId);
  res.json({ ok: true, id: sessionId, status: "logged_out" });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err }, "Unhandled HTTP error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT, dataDir: DATA_DIR, frontendConfigured: Boolean(FRONTEND_URL) }, "FlowPedidos WhatsApp Gateway started");
});
