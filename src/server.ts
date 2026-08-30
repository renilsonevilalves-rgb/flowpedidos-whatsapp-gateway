import "dotenv/config";

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import QRCode from "qrcode";
import pino from "pino";
import {
  DisconnectReason,
  makeWASocket,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "";
const DATA_DIR = process.env.DATA_DIR || "/data/whatsapp-sessions";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const allowedOrigins = FRONTEND_URL
  ? FRONTEND_URL.split(",").map((v) => v.trim()).filter(Boolean)
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-API-Key"],
  }),
);

type SessionStatus =
  | "starting"
  | "qr"
  | "connected"
  | "disconnected"
  | "logged_out"
  | "error";

type Session = {
  id: string;
  status: SessionStatus;
  qr?: string;
  qrDataUrl?: string;
  phone?: string;
  sock?: WASocket;
  starting?: Promise<void>;
};

const sessions = new Map<string, Session>();

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) {
    res.status(500).json({ error: "API_KEY is not configured on the gateway." });
    return;
  }

  const provided = req.header("X-API-Key");
  if (!provided || provided !== API_KEY) {
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

async function connectSession(id: string): Promise<void> {
  const session = getOrCreateSession(id);

  if (session.starting) {
    return session.starting;
  }

  session.starting = (async () => {
    session.status = "starting";
    session.qr = undefined;
    session.qrDataUrl = undefined;

    const authPath = `${DATA_DIR}/${id}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger.child({ sessionId: id }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) => jid === "status@broadcast",
    });

    session.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.status = "qr";
        session.qr = qr;
        session.qrDataUrl = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 420,
        });
        logger.info({ sessionId: id }, "QR code generated");
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

        session.sock = undefined;
        session.qr = undefined;
        session.qrDataUrl = undefined;
        session.status = loggedOut ? "logged_out" : "disconnected";

        logger.warn(
          { sessionId: id, statusCode, loggedOut },
          "WhatsApp connection closed",
        );

        if (!loggedOut) {
          setTimeout(() => {
            void connectSession(id).catch((error) => {
              session.status = "error";
              logger.error({ error, sessionId: id }, "Reconnect failed");
            });
          }, 3000);
        }
      }
    });
  })();

  try {
    await session.starting;
  } finally {
    session.starting = undefined;
  }
}

async function logoutSession(id: string) {
  const session = sessions.get(id);
  if (!session) return;

  try {
    await session.sock?.logout();
  } catch (error) {
    logger.warn({ error, sessionId: id }, "WhatsApp logout returned an error");
  }

  session.sock = undefined;
  session.qr = undefined;
  session.qrDataUrl = undefined;
  session.phone = undefined;
  session.status = "logged_out";
}

// Health endpoint intentionally does not require the API key.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "flowpedidos-whatsapp-gateway",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/session/:sessionId/status", authMiddleware, (req, res) => {
  // Correção 1: type casting explicito para string
  const sessionId = req.params.sessionId as string;

  if (!safeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const session = getOrCreateSession(sessionId);

  res.json({
    id: session.id,
    status: session.status,
    phone: session.phone || null,
    hasQr: Boolean(session.qrDataUrl),
  });
});

app.post("/session/:sessionId/start", authMiddleware, async (req, res) => {
  // Correção 2: type casting explicito para string
  const sessionId = req.params.sessionId as string;

  if (!safeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  try {
    await connectSession(sessionId);

    const session = getOrCreateSession(sessionId);

    res.json({
      ok: true,
      id: session.id,
      status: session.status,
      phone: session.phone || null,
      hasQr: Boolean(session.qrDataUrl),
    });
  } catch (error) {
    const session = getOrCreateSession(sessionId);
    session.status = "error";

    logger.error({ error, sessionId }, "Could not start session");

    res.status(500).json({
      ok: false,
      error: "Could not start WhatsApp session",
    });
  }
});

app.get("/session/:sessionId/qr", authMiddleware, (req, res) => {
  // Correção 3: type casting explicito para string
  const sessionId = req.params.sessionId as string;

  if (!safeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const session = getOrCreateSession(sessionId);

  if (!session.qrDataUrl) {
    res.status(404).json({
      ok: false,
      error: "QR code not available",
      status: session.status,
    });
    return;
  }

  res.json({
    ok: true,
    status: session.status,
    qrDataUrl: session.qrDataUrl,
  });
});

app.post("/session/:sessionId/logout", authMiddleware, async (req, res) => {
  // Correção 4: type casting explicito para string
  const sessionId = req.params.sessionId as string;

  if (!safeSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  await logoutSession(sessionId);

  res.json({
    ok: true,
    id: sessionId,
    status: "logged_out",
  });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err }, "Unhandled HTTP error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info(
    {
      port: PORT,
      dataDir: DATA_DIR,
      frontendConfigured: Boolean(FRONTEND_URL),
    },
    "FlowPedidos WhatsApp Gateway started",
  );
});
