const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
let current = readFileSync(serverPath, "utf8");
let changed = false;

function replaceOnce(original, replacement, label) {
  if (current.includes(replacement)) return;
  if (!current.includes(original)) {
    throw new Error(`Could not locate ${label} in src/server.ts`);
  }
  current = current.replace(original, replacement);
  changed = true;
}

replaceOnce(
  `  reconnectTimer?: ReturnType<typeof setTimeout>;\n};`,
  `  reconnectTimer?: ReturnType<typeof setTimeout>;\n  reconnectAttempts?: number;\n};`,
  "Session reconnect state",
);

replaceOnce(
  `const pairingRequestsInFlight = new Set<string>();`,
  `const pairingRequestsInFlight = new Set<string>();\nlet shuttingDown = false;`,
  "gateway shutdown state",
);

replaceOnce(
`function scheduleReconnect(id: string, fresh = false, delayMs = 1500) {
  const session = getOrCreateSession(id);
  if (manualLogouts.has(id) || session.reconnectTimer) return;
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = undefined;
    void connectSession(id, fresh).catch((error) => {
      session.status = "error";
      logger.error({ error, sessionId: id }, "Reconnect failed");
    });
  }, delayMs);
}`,
`function scheduleReconnect(id: string, _fresh = false, delayMs?: number) {
  const session = getOrCreateSession(id);
  if (shuttingDown || manualLogouts.has(id) || session.reconnectTimer) return;

  const attempt = session.reconnectAttempts || 0;
  const exponentialDelay = Math.min(30000, 1500 * (2 ** Math.min(attempt, 5)));
  const baseDelay = typeof delayMs === "number" ? Math.max(delayMs, exponentialDelay) : exponentialDelay;
  const finalDelay = baseDelay + Math.floor(Math.random() * 500);
  session.reconnectAttempts = attempt + 1;

  logger.info({ sessionId: id, reconnectAttempt: session.reconnectAttempts, delayMs: finalDelay }, "Scheduling WhatsApp reconnect");
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = undefined;
    if (shuttingDown || manualLogouts.has(id)) return;

    void connectSession(id, false).catch((error) => {
      session.status = "disconnected";
      logger.error({ error, sessionId: id }, "Reconnect failed; retry will be scheduled");
      scheduleReconnect(id, false);
    });
  }, finalDelay);
}`,
  "reconnect scheduler",
);

replaceOnce(
`  if (session.starting) return session.starting;
  if (session.status === "connected" && session.sock) return;
  if (forceFresh) await clearAuthState(id);`,
`  if (session.starting) return session.starting;
  // One live socket per tenant. Creating a second socket for the same auth state
  // is a primary cause of WhatsApp connectionReplaced/conflict loops.
  if (session.sock) return;
  if (forceFresh) await clearAuthState(id);`,
  "single-socket guard",
);

replaceOnce(
`      if (connection === "open") {
        session.status = "connected";
        session.qr = undefined;
        session.qrDataUrl = undefined;
        session.phone = sock.user?.id?.split(":")[0];
        logger.info({ sessionId: id, phone: session.phone }, "WhatsApp connected");
      }`,
`      if (connection === "open") {
        session.status = "connected";
        session.qr = undefined;
        session.qrDataUrl = undefined;
        session.phone = sock.user?.id?.split(":")[0];
        session.reconnectAttempts = 0;
        if (session.reconnectTimer) {
          clearTimeout(session.reconnectTimer);
          session.reconnectTimer = undefined;
        }
        logger.info({ sessionId: id, phone: session.phone }, "WhatsApp connected");
      }`,
  "connection-open reset",
);

replaceOnce(
`      if (connection === "close") {
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
      }`,
`      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const badSession = statusCode === DisconnectReason.badSession;
        const connectionReplaced = statusCode === DisconnectReason.connectionReplaced;
        const manuallyLoggedOut = manualLogouts.has(id);
        session.sock = undefined;
        session.qr = undefined;
        session.qrDataUrl = undefined;
        session.phone = undefined;

        if (manuallyLoggedOut) {
          manualLogouts.delete(id);
          session.status = "logged_out";
          session.reconnectAttempts = 0;
          return;
        }

        if (shuttingDown) {
          session.status = "disconnected";
          return;
        }

        // Only a confirmed logout invalidates the persisted credentials.
        // Timeouts, network failures, server restarts and bad-session signals
        // must never erase a tenant's auth state automatically.
        if (loggedOut) {
          session.status = "logged_out";
          session.reconnectAttempts = 0;
          await clearAuthState(id);
          logger.warn({ sessionId: id, statusCode }, "WhatsApp session was explicitly logged out; re-pairing is required");
          return;
        }

        // During rolling deployments a newer gateway instance can take over the
        // same WhatsApp session. The replaced instance must not fight back and
        // create an endless connection-replaced loop.
        if (connectionReplaced) {
          session.status = "disconnected";
          logger.warn({ sessionId: id, statusCode }, "WhatsApp connection was replaced; reconnect suppressed on this socket");
          return;
        }

        session.status = "disconnected";
        if (badSession) {
          logger.warn({ sessionId: id, statusCode }, "WhatsApp reported badSession; credentials preserved and recovery will be attempted");
        }

        if (state.creds.registered) {
          scheduleReconnect(id, false, 3000);
        } else {
          session.reconnectAttempts = 0;
          logger.info({ sessionId: id, statusCode }, "Unregistered WhatsApp session closed; waiting for explicit pairing instead of reconnect loop");
        }
      }`,
  "connection-close recovery policy",
);

replaceOnce(
`async function startSessionWithRecovery(id: string) {
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
}`,
`async function startSessionWithRecovery(id: string) {
  const session = getOrCreateSession(id);
  if (session.status === "connected" && session.sock) return;

  // A manual start may race with a scheduled reconnect. Cancel only the timer;
  // never delete persisted credentials because a connection took longer than expected.
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = undefined;
  }

  await connectSession(id, false);
  const status = await waitForQrOrConnected(id, 15000);
  if (status === "error") throw new Error("Could not initialize WhatsApp session");
}`,
  "non-destructive session start recovery",
);

const listenBlock = `app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT, dataDir: DATA_DIR, frontendConfigured: Boolean(FRONTEND_URL) }, "FlowPedidos WhatsApp Gateway started");
  void restorePersistedSessions();
});`;

const gracefulBlock = `app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT, dataDir: DATA_DIR, frontendConfigured: Boolean(FRONTEND_URL) }, "FlowPedidos WhatsApp Gateway started");
  void restorePersistedSessions();
});

async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, activeSessions: sessions.size }, "Graceful WhatsApp gateway shutdown started");

  for (const session of sessions.values()) {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = undefined;
    }
    if (session.sock) {
      try {
        session.sock.end(undefined);
      } catch (error) {
        logger.debug({ error, sessionId: session.id }, "Error while closing WhatsApp socket during shutdown");
      }
      session.sock = undefined;
    }
  }

  // Give pending credential writes and socket close frames a brief chance to flush.
  await new Promise((resolve) => setTimeout(resolve, 500));
  logger.info({ signal }, "Graceful WhatsApp gateway shutdown completed");
  process.exit(0);
}

process.once("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.once("SIGINT", () => { void gracefulShutdown("SIGINT"); });`;

replaceOnce(listenBlock, gracefulBlock, "graceful shutdown handler");

if (changed) {
  writeFileSync(serverPath, current, "utf8");
  console.log("Patched production-grade WhatsApp session resilience");
} else {
  console.log("Production WhatsApp session resilience is already present in src/server.ts");
}
