// Liga a vigilância de saúde da conexão (src/connectionHealth.ts) e a resposta às
// mensagens recebidas durante quedas/reinícios (src/offlineMessages.ts).
// Roda por último no prebuild, sobre o server.ts já ajustado pelos outros patches.
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const path = resolve(__dirname, "../src/server.ts");
let source = readFileSync(path, "utf8");
const MARKER = "// Connection health watchdog v1";
if (source.includes(MARKER)) {
  console.log("Connection health watchdog already integrated");
  return;
}

function replaceOnce(original, replacement, label) {
  const first = source.indexOf(original);
  if (first === -1) throw new Error(`Connection health: ${label} not found in src/server.ts`);
  if (source.indexOf(original, first + original.length) !== -1) {
    throw new Error(`Connection health: ${label} is ambiguous in src/server.ts`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + original.length);
}

// 1) Imports.
const importAnchor = 'import { drainOrderReceipts } from "./chatReceiptOutbox.js";';
replaceOnce(importAnchor, `${importAnchor}
import { stallRecoveryDelayMs, watchConnectionHealth, type StallReason } from "./connectionHealth.js";
import { offlineReplyMaxAgeMs, selectOfflineCustomerMessages } from "./offlineMessages.js";`, "import anchor");

// 2) Recuperação de loja travada (conectada, mas sem receber mensagens).
const connectAnchor = "async function connectSession(id: string, forceFresh = false): Promise<void> {";
replaceOnce(connectAnchor, `${MARKER}
const stallHistory = new Map<string, number[]>();

function recoverStalledSession(id: string, sock: any, reason: StallReason, details: Record<string, unknown>) {
  const session = sessions.get(id);
  if (!session || session.sock !== sock || shuttingDown || manualLogouts.has(id)) return;
  const now = Date.now();
  const recent = (stallHistory.get(id) || []).filter((at) => now - at < 30 * 60_000);
  recent.push(now);
  stallHistory.set(id, recent);
  const delayMs = stallRecoveryDelayMs(recent.length);
  logger.error({ sessionId: id, reason, stallsLast30Min: recent.length, delayMs, ...details },
    "[Health] WhatsApp da loja conectado mas sem receber mensagens; reconectando automaticamente");
  const forceReconnect = () => {
    if (session.sock !== sock || shuttingDown || manualLogouts.has(id)) return;
    try { sock.end(new Error(\`connection-health:\${reason}\`)); } catch (error: any) {
      logger.warn({ sessionId: id, error: error?.message || String(error) }, "[Health] Falha ao encerrar socket travado");
    }
  };
  if (delayMs > 0) setTimeout(forceReconnect, delayMs);
  else forceReconnect();
}

${connectAnchor}`, "connectSession declaration");

// 3) Vigiar cada socket novo assim que é criado.
const socketCreated = '    logger.info({ sessionId: id, generation }, "WhatsApp socket created");';
replaceOnce(socketCreated, `${socketCreated}
    // Guarded: isolated lifecycle tests load connectSession without the watchdog module.
    if (typeof watchConnectionHealth === "function") {
      watchConnectionHealth({
        sessionId: id, sock, logger,
        isCurrent: () => session.sock === sock && isCurrent(),
        onStall: (reason, details) => recoverStalledSession(id, sock, reason, details),
      });
    }`, "socket created log");

// 4) Responder mensagens que chegaram durante a queda ("append"), não só as em tempo real.
const appendGate = `  trackOwnSends(id, sock);
  if (type !== "notify") return;
`;
replaceOnce(appendGate, `  trackOwnSends(id, sock);
  if (type !== "notify") {
    // Mensagens recebidas enquanto a conexão estava fora (reinício, queda) chegam como "append".
    if (type !== "append" || process.env.WHATSAPP_REPLY_OFFLINE_MESSAGES === "false") return;
    const offline = selectOfflineCustomerMessages(messages, {
      maxAgeMs: offlineReplyMaxAgeMs(),
      isOwnSend: (messageId) => ownSentIds.has(messageId),
    });
    for (const jid of offline.storeTakeovers) {
      void pauseAi(id, jid, MANUAL_PAUSE_MINUTES, "manual_reply");
      logger.info({ sessionId: id }, "[Offline] Loja já respondeu pelo celular durante a queda; robô pausado para este cliente");
    }
    if (!offline.customerMessages.length) return;
    logger.info({ sessionId: id, count: offline.customerMessages.length }, "[Offline] Respondendo mensagens recebidas durante a reconexão");
    messages = offline.customerMessages;
  }
`, "incoming type gate");

// 5) Marca no log quando a mensagem veio do acúmulo.
const incomingLog = '      logger.info({ sessionId: id, remoteJid, text }, "[Incoming] WhatsApp message received");';
replaceOnce(incomingLog,
  '      logger.info({ sessionId: id, remoteJid, text, ...(type === "append" ? { offline: true } : {}) }, "[Incoming] WhatsApp message received");',
  "incoming log");

writeFileSync(path, source, "utf8");
console.log("Connection health watchdog and offline replies integrated");
