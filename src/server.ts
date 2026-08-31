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
const VERCEL_API_URL = (process.env.VERCEL_API_URL || "").replace(/\/$/, "");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const allowedOrigins = FRONTEND_URL
  ? FRONTEND_URL
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)
      ) {
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

/**
 * Evita processar duas vezes a mesma mensagem.
 */
const processedMessages = new Set<string>();

/**
 * Guarda quando o bot respondeu pela última vez
 * para cada loja/cliente.
 */
const userLastReply = new Map<string, number>();

function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!API_KEY) {
    res.status(500).json({
      error: "API_KEY is not configured on the gateway.",
    });
    return;
  }

  const provided = req.header("X-API-Key");

  if (!provided || provided !== API_KEY) {
    res.status(401).json({
      error: "Unauthorized",
    });
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
    session = {
      id,
      status: "disconnected",
    };

    sessions.set(id, session);
  }

  return session;
}

/**
 * Conecta uma sessão do WhatsApp.
 */
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

    const { state, saveCreds } =
      await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: logger.child({
        sessionId: id,
      }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) =>
        jid === "status@broadcast",
    });

    session.sock = sock;

    /**
     * Salva as credenciais do WhatsApp.
     */
    sock.ev.on("creds.update", saveCreds);

    /**
     * RECEBIMENTO DE MENSAGENS
     *
     * Quando alguém enviar uma mensagem para o WhatsApp
     * conectado, este bloco será executado.
     */
    sock.ev.on("messages.upsert", async (m) => {
      try {
        if (m.type !== "notify") {
          return;
        }

        for (const msg of m.messages) {
          /**
           * Ignora:
           * - mensagens sem conteúdo
           * - mensagens enviadas pelo próprio bot
           */
          if (!msg.message || msg.key.fromMe) {
            continue;
          }

          const remoteJid = msg.key.remoteJid;

          /**
           * Ignora:
           * - mensagens sem remetente
           * - status do WhatsApp
           * - grupos
           */
          if (
            !remoteJid ||
            remoteJid === "status@broadcast" ||
            remoteJid.endsWith("@g.us")
          ) {
            continue;
          }

          /**
           * Evita processar a mesma mensagem duas vezes.
           */
          if (msg.key.id) {
            if (processedMessages.has(msg.key.id)) {
              continue;
            }

            processedMessages.add(msg.key.id);

            /**
             * Limita o tamanho do cache.
             */
            if (processedMessages.size > 5000) {
              const firstItem =
                processedMessages.values().next().value;

              if (firstItem) {
                processedMessages.delete(firstItem);
              }
            }
          }

          /**
           * Obtém texto de mensagens comuns
           * e mensagens de texto estendido.
           */
          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

          if (!text.trim()) {
            continue;
          }

          logger.info(
            {
              sessionId: id,
              remoteJid,
              text,
            },
            "[Incoming] WhatsApp message received",
          );

          const lowerText = text
            .toLowerCase()
            .trim();

          /**
           * Palavras/frases que ativam a resposta.
           */
          const triggers = [
            "oi",
            "olá",
            "ola",
            "bom dia",
            "boa tarde",
            "boa noite",
            "tudo bem",
            "quero fazer um pedido",
            "cardápio",
            "cardapio",
            "menu",
            "pedido",
          ];

          const isTrigger = triggers.some((trigger) =>
            lowerText.includes(trigger),
          );

          /**
           * Identifica o cliente dentro da sessão da loja.
           */
          const userKey = `${id}-${remoteJid}`;

          const now = Date.now();

          const lastReplyTime =
            userLastReply.get(userKey) || 0;

          /**
           * Permite uma nova resposta automática
           * depois de 4 horas.
           */
          const fourHours = 1000 * 60 * 60 * 4;

          const canReplyAfterFourHours =
            now - lastReplyTime > fourHours;

          /**
           * Se não for uma mensagem de gatilho e ainda
           * não passaram 4 horas, não responde.
           */
          if (!isTrigger && !canReplyAfterFourHours) {
            continue;
          }

          /**
           * Verifica se o endereço da Vercel foi configurado.
           */
          if (!VERCEL_API_URL) {
            logger.error(
              "[Auto-Reply] VERCEL_API_URL não configurada no Railway.",
            );

            continue;
          }

          /**
           * Consulta a Vercel para descobrir:
           * - qual é a loja
           * - qual é o link do cardápio
           * - qual mensagem automática foi configurada
           */
          const response = await fetch(
            `${VERCEL_API_URL}/api/webhook/whatsapp/store-info`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-Key": API_KEY,
              },
              body: JSON.stringify({
                sessionId: id,
              }),
            },
          );

          if (!response.ok) {
            const errorText = await response
              .text()
              .catch(() => "");

            logger.error(
              {
                status: response.status,
                error: errorText,
                sessionId: id,
              },
              "[Auto-Reply] Vercel retornou erro",
            );

            continue;
          }

          const storeInfo = await response.json();

          /**
           * A loja precisa ter um cardápio.
           */
          if (!storeInfo.menuUrl) {
            logger.warn(
              {
                sessionId: id,
              },
              "[Auto-Reply] Loja sem menuUrl.",
            );

            continue;
          }

          /**
           * Usa a mensagem configurada pelo lojista.
           */
          let replyText = storeInfo.autoReplyMessage;

          /**
           * Caso o lojista ainda não tenha configurado
           * uma mensagem, utiliza esta mensagem padrão.
           */
          if (!replyText) {
            replyText =
              `Olá! 👋 Seja bem-vindo ao nosso atendimento.\n\n` +
              `Confira nosso cardápio digital e faça seu pedido:\n\n` +
              `${storeInfo.menuUrl}`;
          } else {
            /**
             * Se a mensagem possuir {link},
             * substitui pelo link real do cardápio.
             */
            if (replyText.includes("{link}")) {
              replyText = replyText.replace(
                "{link}",
                storeInfo.menuUrl,
              );
            } else {
              /**
               * Caso o lojista não tenha colocado {link},
               * adiciona o link automaticamente.
               */
              replyText =
                replyText +
                `\n\n${storeInfo.menuUrl}`;
            }
          }

          /**
           * Envia a resposta diretamente pelo WhatsApp
           * conectado no Railway.
           */
          await sock.sendMessage(remoteJid, {
            text: replyText,
          });

          /**
           * Registra o horário da resposta.
           */
          userLastReply.set(userKey, now);

          logger.info(
            {
              sessionId: id,
              remoteJid,
            },
            "[Auto-Reply] Resposta enviada com sucesso.",
          );
        }
      } catch (error: any) {
        logger.error(
          {
            error: error?.message || error,
            sessionId: id,
          },
          "[Auto-Reply] Erro ao processar mensagem.",
        );
      }
    });

    /**
     * Controle da conexão do WhatsApp.
     */
    sock.ev.on("connection.update", async (update) => {
      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      /**
       * QR Code gerado.
       */
      if (qr) {
        session.status = "qr";
        session.qr = qr;

        session.qrDataUrl =
          await QRCode.toDataURL(qr, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 420,
          });

        logger.info(
          {
            sessionId: id,
          },
          "QR code generated",
        );
      }

      /**
       * WhatsApp conectado.
       */
      if (connection === "open") {
        session.status = "connected";
        session.qr = undefined;
        session.qrDataUrl = undefined;

        session.phone =
          sock.user?.id?.split(":")[0];

        logger.info(
          {
            sessionId: id,
            phone: session.phone,
          },
          "WhatsApp connected",
        );
      }

      /**
       * WhatsApp desconectado.
       */
      if (connection === "close") {
        const statusCode = (
          lastDisconnect?.error as any
        )?.output?.statusCode;

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        session.sock = undefined;
        session.qr = undefined;
        session.qrDataUrl = undefined;

        session.status = loggedOut
          ? "logged_out"
          : "disconnected";

        logger.warn(
          {
            sessionId: id,
            statusCode,
            loggedOut,
          },
          "WhatsApp connection closed",
        );

        /**
         * Se não foi logout manual, tenta reconectar
         * automaticamente depois de 3 segundos.
         */
        if (!loggedOut) {
          setTimeout(() => {
            void connectSession(id).catch(
              (error) => {
                session.status = "error";

                logger.error(
                  {
                    error,
                    sessionId: id,
                  },
                  "Reconnect failed",
                );
              },
            );
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

/**
 * Logout da sessão.
 */
async function logoutSession(id: string) {
  const session = sessions.get(id);

  if (!session) {
    return;
  }

  try {
    await session.sock?.logout();
  } catch (error) {
    logger.warn(
      {
        error,
        sessionId: id,
      },
      "WhatsApp logout returned an error",
    );
  }

  session.sock = undefined;
  session.qr = undefined;
  session.qrDataUrl = undefined;
  session.phone = undefined;
  session.status = "logged_out";
}

/**
 * Health check.
 * Não exige API KEY.
 */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "flowpedidos-whatsapp-gateway",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Status da sessão.
 */
app.get(
  "/session/:sessionId/status",
  authMiddleware,
  (req, res) => {
    const sessionId =
      req.params.sessionId as string;

    if (!safeSessionId(sessionId)) {
      res.status(400).json({
        error: "Invalid sessionId",
      });
      return;
    }

    const session =
      getOrCreateSession(sessionId);

    res.json({
      id: session.id,
      status: session.status,
      phone: session.phone || null,
      hasQr: Boolean(session.qrDataUrl),
    });
  },
);

/**
 * Inicia uma sessão.
 */
app.post(
  "/session/:sessionId/start",
  authMiddleware,
  async (req, res) => {
    const sessionId =
      req.params.sessionId as string;

    if (!safeSessionId(sessionId)) {
      res.status(400).json({
        error: "Invalid sessionId",
      });
      return;
    }

    try {
      await connectSession(sessionId);

      const session =
        getOrCreateSession(sessionId);

      res.json({
        ok: true,
        id: session.id,
        status: session.status,
        phone: session.phone || null,
        hasQr: Boolean(session.qrDataUrl),
      });
    } catch (error) {
      const session =
        getOrCreateSession(sessionId);

      session.status = "error";

      logger.error(
        {
          error,
          sessionId,
        },
        "Could not start session",
      );

      res.status(500).json({
        ok: false,
        error:
          "Could not start WhatsApp session",
      });
    }
  },
);

/**
 * Retorna o QR Code.
 */
app.get(
  "/session/:sessionId/qr",
  authMiddleware,
  (req, res) => {
    const sessionId =
      req.params.sessionId as string;

    if (!safeSessionId(sessionId)) {
      res.status(400).json({
        error: "Invalid sessionId",
      });
      return;
    }

    const session =
      getOrCreateSession(sessionId);

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
  },
);

/**
 * Desconecta uma sessão.
 */
app.post(
  "/session/:sessionId/logout",
  authMiddleware,
  async (req, res) => {
    const sessionId =
      req.params.sessionId as string;

    if (!safeSessionId(sessionId)) {
      res.status(400).json({
        error: "Invalid sessionId",
      });
      return;
    }

    await logoutSession(sessionId);

    res.json({
      ok: true,
      id: sessionId,
      status: "logged_out",
    });
  },
);

/**
 * Tratamento global de erros.
 */
app.use(
  (
    err: Error,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    logger.error(
      {
        error: err,
      },
      "Unhandled HTTP error",
    );

    res.status(500).json({
      error: "Internal server error",
    });
  },
);

/**
 * Inicialização do servidor.
 */
app.listen(PORT, "0.0.0.0", () => {
  logger.info(
    {
      port: PORT,
      dataDir: DATA_DIR,
      frontendConfigured:
        Boolean(FRONTEND_URL),
      vercelApiConfigured:
        Boolean(VERCEL_API_URL),
    },
    "FlowPedidos WhatsApp Gateway started",
  );
});
