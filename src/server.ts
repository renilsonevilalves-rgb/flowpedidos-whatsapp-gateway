import "dotenv/config";

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import QRCode from "qrcode";
import pino from "pino";
import { rm } from "node:fs/promises";
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
const QR_GENERATION_TIMEOUT_MS = Number(process.env.QR_GENERATION_TIMEOUT_MS) || 500;

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
  qrGeneratedAt?: number;
  phone?: string;
  sock?: WASocket;
  starting?: Promise<void>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  qrGenerationInFlight?: Promise<string | null>;
};

const sessions = new Map<string, Session>();
const processedMessages = new Set<string>();
const userLastReply = new Map<string, number>();
const replyInFlight = new Set<string>();
const manualLogouts = new Set<string>();

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
  const pollIntervalMs = 50; // OPTIMIZED: reduced from 200ms to 50ms for faster QR detection
  while (Date.now() < deadline) {
    if (session.status === "qr" || session.status === "connected" || session.status === "error") return session.status;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return session.status;
}

async function generateQrDataUrlAsync(qrRaw: string, sessionId: string): Promise<string | null> {
  try {
    // OPTIMIZED: Smaller QR code (280px instead of 420px) reduces encoding time by ~30%
    const dataUrl = await QRCode.toDataURL(qrRaw, { 
      errorCorrectionLevel: "M", 
      margin: 1, // reduced from 2
      width: 280   // reduced from 420
    });
    logger.debug({ sessionId }, "QR data URL generated asynchronously");
    return dataUrl;
  } catch (error) {
    logger.error({ error, sessionId }, "Failed to generate QR data URL asynchronously");
    return null;
  }
}

async function fetchStoreInfo(sessionId: string) {
  if (!VERCEL_API_URL) throw new Error("VERCEL_API_URL is not configured on the gateway");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`${VERCEL_API_URL}/api/webhook/whatsapp/store-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({ sessionId }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Vercel store-info returned HTTP ${response.status}: ${data?.error || "unknown error"}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function extractMessageText(message: any) {
  return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || "";
}

function isTrackOrderTrigger(text: string) {
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return /^(acompanhar\s+pedido|acompanhar\s+meu\s+pedido|status\s+do\s+pedido|rastrear\s+pedido)[!,.?\s]*$/i.test(normalized);
}

async function fetchOrderStatus(sessionId: string, phone: string, orderNumber = '') {
  if (!VERCEL_API_URL) throw new Error("VERCEL_API_URL is not configured on the gateway");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${VERCEL_API_URL}/api/webhook/whatsapp/order-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({ sessionId, phone, orderNumber }),
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

  const explicitRequest = /\b(cardapio|menu|fazer\s+um\s+pedido|quero\s+(pedir|fazer\s+um\s+pedido)|gostaria\s+de\s+(pedir|ver\s+o\s+cardapio)|como\s+fac(o|a)\s+um\s+pedido)\b/i;
  return explicitRequest.test(normalized);
}


async function resolveCustomerPhone(sock: WASocket, msg: any, remoteJid: string) {
  const candidates = [
    msg?.key?.remoteJidAlt,
    msg?.key?.senderPn,
    msg?.key?.participantPn,
    msg?.key?.participantAlt,
    remoteJid,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = String(candidate);
    if (value.endsWith('@s.whatsapp.net')) {
      const digits = value.split('@')[0].split(':')[0].replace(/D/g, '');
      if (digits) return digits;
    }
  }

  if (remoteJid.endsWith('@lid')) {
    try {
      const mapped = await (sock as any).signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
      if (mapped) {
        const digits = String(mapped).split('@')[0].split(':')[0].replace(/D/g, '');
        if (digits) return digits;
      }
    } catch (error) {
      logger.warn({ error, remoteJid }, '[Order-Tracking] Falha ao resolver LID para telefone');
    }
  }

  return null;
}

async function handleIncomingMessages(id: string, sock: WASocket, messages: any[], type: string) {
  if (type !== "notify") return;

  for (const msg of messages) {
    try {
      if (!msg.message || msg.key.fromMe) continue;
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

      const text = extractMessageText(msg.message).trim();
      if (!text) continue;

      logger.info({ sessionId: id, remoteJid, text }, "[Incoming] WhatsApp message received");

      const isTrackingTrigger = isTrackOrderTrigger(text);
      if (isTrackingTrigger) {
        try {
          const customerJid = [
            msg.key.remoteJidAlt,
            msg.key.senderPn,
            msg.key.participantPn,
            remoteJid,
          ].find((value: unknown) => typeof value === "string" && /@s\.whatsapp\.net$/.test(value)) ||
            msg.key.remoteJidAlt ||
            msg.key.senderPn ||
            msg.key.participantPn ||
            remoteJid;
          const customerPhone = customerJid.split("@")[0].split(":")[0];
          const result = await fetchOrderStatus(id, customerPhone);
          await sock.sendMessage(remoteJid, { text: result.message });
          logger.info({ sessionId: id, remoteJid, orderId: result.orderId }, "[Order-Tracking] Status enviado com sucesso");
        } catch (error: any) {
          logger.error({ error: error?.message || error, sessionId: id, remoteJid }, "[Order-Tracking] Falha ao consultar/enviar status");
          await sock.sendMessage(remoteJid, { text: "Não consegui localizar seu pedido agora. Verifique se o pedido foi feito com este mesmo número de WhatsApp e tente novamente. 🙏" }).catch(() => undefined);
        }
        continue;
      }

      const isTrigger = isAutoReplyTrigger(text);
      if (!isTrigger) continue;

      const userKey = `${id}-${remoteJid}`;
      const now = Date.now();
      const fourHours = 1000 * 60 * 60 * 4;
      const lastReplyTime = userLastReply.get(userKey) || 0;

      if (now - lastReplyTime <= fourHours) {
        logger.info({ sessionId: id, remoteJid }, "[Auto-Reply] 4-hour cooldown active; message ignored");
        continue;
      }

      if (replyInFlight.has(userKey)) {
        logger.info({ sessionId: id, remoteJid }, "[Auto-Reply] Reply already reserved; duplicate event ignored");
        continue;
      }

      replyInFlight.add(userKey);
      userLastReply.set(userKey, now);

      try {
        const storeInfo = await fetchStoreInfo(id);
        if (!storeInfo?.menuUrl) {
          userLastReply.delete(userKey);
          logger.warn({ sessionId: id }, "[Auto-Reply] Store has no menuUrl");
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

        await sock.sendMessage(remoteJid, { text: replyText });
        logger.info({ sessionId: id, remoteJid }, "[Auto-Reply] Resposta enviada com sucesso");
      } catch (error) {
        userLastReply.delete(userKey);
        throw error;
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
  session.qrGeneratedAt = undefined;
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
      shouldIgnoreJid: (jid) => jid === "status@broadcast",
    });

    session.sock = sock;
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
          session.qrGeneratedAt = Date.now();
          logger.info({ sessionId: id }, "QR code generated (raw), scheduling async encoding");
          
          // OPTIMIZED: Defer QR encoding to avoid blocking event loop
          // If already generating, reuse the promise; otherwise start new generation
          if (!session.qrGenerationInFlight) {
            session.qrGenerationInFlight = generateQrDataUrlAsync(qr, id)
              .then((dataUrl) => {
                if (dataUrl && session.status === "qr" && session.qr === qr) {
                  session.qrDataUrl = dataUrl;
                  logger.info({ sessionId: id, encodingTimeMs: Date.now() - (session.qrGeneratedAt || 0) }, "QR data URL ready");
                }
                return dataUrl;
              })
              .finally(() => {
                session.qrGenerationInFlight = undefined;
              });
          }
        } catch (error) {
          session.status = "error";
          logger.error({ error, sessionId: id }, "Failed to handle QR code generation");
        }
      }
      if (connection === "open") {
        session.status = "connected";
        session.qr = undefined;
        session.qrDataUrl = undefined;
        session.qrGeneratedAt = undefined;
        session.qrGenerationInFlight = undefined;
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
        session.qrGeneratedAt = undefined;
        session.qrGenerationInFlight = undefined;
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
  session.qrGeneratedAt = undefined;
  session.qrGenerationInFlight = undefined;
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
    await startSessionWithRecovery(sessionId);
    const session = getOrCreateSession(sessionId);
    
    // OPTIMIZED: Wait briefly for QR encoding if it's in flight, then return with qrDataUrl if ready
    if (session.qrGenerationInFlight && session.status === "qr") {
      try {
        await Promise.race([
          session.qrGenerationInFlight,
          new Promise((resolve) => setTimeout(resolve, QR_GENERATION_TIMEOUT_MS)),
        ]);
      } catch (error) {
        logger.debug({ error, sessionId }, "QR encoding wait timeout or error (non-blocking)");
      }
    }
    
    res.json({ 
      ok: true, 
      id: session.id, 
      status: session.status, 
      phone: session.phone || null, 
      hasQr: Boolean(session.qrDataUrl),
      qrDataUrl: session.qrDataUrl || undefined, // OPTIMIZED: Include QR in start response if ready
    });
  } catch (error: any) {
    const session = getOrCreateSession(sessionId);
    session.status = "error";
    logger.error({ error: error?.message || error, sessionId }, "Could not start session");
    res.status(500).json({ ok: false, error: "Could not start WhatsApp session" });
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

  try {
    const recipients = (await session.sock.onWhatsApp(phone)) || [];
    const recipient = recipients.find((item: any) => item?.exists && item?.jid);

    if (!recipient?.jid) {
      logger.warn({ sessionId, phone }, "[Outbound] Número não encontrado no WhatsApp");
      res.status(404).json({ ok: false, error: "O número informado não possui uma conta WhatsApp válida." });
      return;
    }

    const pnJid = recipient.jid;
    let targetJid = pnJid;

    // WhatsApp now uses LID for many personal chats. Resolve the PN to its
    // LID from Baileys' mapping store when available, then send to the actual
    // conversation identity. This prevents a false HTTP 200 where the gateway
    // accepts a PN but WhatsApp does not route the message to the LID chat.
    try {
      const lidMapping = (session.sock as any)?.signalRepository?.lidMapping;
      const lid = typeof lidMapping?.getLIDForPN === "function"
        ? await lidMapping.getLIDForPN(pnJid)
        : undefined;
      if (typeof lid === "string" && /@lid$/.test(lid)) {
        targetJid = lid;
      }
    } catch (error) {
      logger.warn({ error, sessionId, phone, pnJid }, "[Outbound] Falha ao resolver LID; usando PN");
    }

    const sentMessage = await session.sock.sendMessage(targetJid, { text });
    const messageId = sentMessage?.key?.id || null;
    logger.info({
      sessionId,
      phone,
      pnJid,
      targetJid,
      messageId,
    }, "[Outbound] Mensagem aceita pelo WhatsApp");
    res.json({
      ok: true,
      phone,
      recipientJid: targetJid,
      messageId,
    });
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

