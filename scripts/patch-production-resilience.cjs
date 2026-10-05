const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
let current = readFileSync(serverPath, "utf8");
let changed = false;

// Later prebuild steps preserve these lifecycle guards on repeated builds.
if (current.includes("// Generation-owned WhatsApp lifecycle v1")) {
  console.log("WhatsApp lifecycle generation guards are already present");
  return;
}

function replaceOnce(original, replacement, label, previous) {
  if (current.includes(replacement)) return;
  if (previous && current.includes(previous)) original = previous;
  if (!current.includes(original)) {
    throw new Error(`Could not locate ${label} in src/server.ts`);
  }
  current = current.replace(original, replacement);
  changed = true;
}

replaceOnce(
  `  reconnectTimer?: ReturnType<typeof setTimeout>;\n};`,
  `  reconnectTimer?: ReturnType<typeof setTimeout>;\n  generation?: number;\n  loggingOut?: Promise<void>;\n  pendingCredsSave?: Promise<void>;\n  pairingRestartPending?: boolean;\n  reconnectAttempts?: number;\n};`,
  "Session reconnect state",
  `  reconnectTimer?: ReturnType<typeof setTimeout>;\n  reconnectAttempts?: number;\n};`,
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
  if (shuttingDown || manualLogouts.has(id) || session.loggingOut || session.reconnectTimer) return;
  const generation = session.generation;

  const attempt = session.reconnectAttempts || 0;
  const exponentialDelay = Math.min(30000, 1500 * (2 ** Math.min(attempt, 5)));
  const baseDelay = typeof delayMs === "number" ? Math.max(delayMs, exponentialDelay) : exponentialDelay;
  const finalDelay = baseDelay + Math.floor(Math.random() * 500);
  session.reconnectAttempts = attempt + 1;

  logger.info({ sessionId: id, reconnectAttempt: session.reconnectAttempts, delayMs: finalDelay }, "Scheduling WhatsApp reconnect");
  const timer = session.reconnectTimer = setTimeout(() => {
    if (session.reconnectTimer !== timer || session.generation !== generation) return;
    session.reconnectTimer = undefined;
    if (shuttingDown || manualLogouts.has(id)) return;

    const reconnect = connectSession(id, false);
    const reconnectGeneration = session.generation;
    void reconnect.catch((error) => {
      if (session.generation !== reconnectGeneration || session.loggingOut) return;
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
`  if (session.loggingOut) {
    await session.loggingOut;
    return connectSession(id, forceFresh);
  }
  if (session.starting) return session.starting;
  // One live socket per tenant. Creating a second socket for the same auth state
  // is a primary cause of WhatsApp connectionReplaced/conflict loops.
  if (session.sock) return;
  // Generation-owned WhatsApp lifecycle v1
  const generation = (session.generation || 0) + 1;
  session.generation = generation;
  const isCurrent = () => session.generation === generation && !manualLogouts.has(id) && !shuttingDown;
  forceFresh = forceFresh || session.status === "logged_out";
  // Auth loading and credential persistence run inside the shared starting lock.`,
  "single-socket guard",
`  if (session.starting) return session.starting;
  // One live socket per tenant. Creating a second socket for the same auth state
  // is a primary cause of WhatsApp connectionReplaced/conflict loops.
  if (session.sock) return;
  if (forceFresh) await clearAuthState(id);`,
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
        previouslyConnected = true;
        session.reconnectAttempts = 0;
        if (session.reconnectTimer) {
          clearTimeout(session.reconnectTimer);
          session.reconnectTimer = undefined;
        }
        logger.info({ sessionId: id, phone: session.phone }, "WhatsApp connected");
        if (session.pairingRestartPending) {
          session.pairingRestartPending = false;
          logger.info({ sessionId: id }, "WhatsApp connected after pairing restart");
        }
      }`,
  "connection-open reset",
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
        const restartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
        const manuallyLoggedOut = manualLogouts.has(id);
        logger.info({ sessionId: id, generation, statusCode }, "WhatsApp connection closed");
        // Freeze the old socket's write queue before releasing its ownership.
        sock.ev.off("creds.update", persistCreds);
        if (session.reconnectTimer) {
          clearTimeout(session.reconnectTimer);
          session.reconnectTimer = undefined;
        }
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
          session.pairingRestartPending = false;
          // Block /start until pending writes and real logout cleanup finish.
          const cleanup = Promise.resolve().then(async () => {
            await session.pendingCredsSave?.catch(() => {});
            await clearAuthState(id);
            session.pendingCredsSave = undefined;
          });
          session.loggingOut = cleanup;
          try { await cleanup; } catch {
            logger.error({ sessionId: id }, "WhatsApp logout cleanup failed; explicit retry required");
          } finally {
            if (session.loggingOut === cleanup) session.loggingOut = undefined;
          }
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

        if (restartRequired && session.pairingRestartPending && !previouslyConnected) {
          session.status = "error";
          session.pairingRestartPending = false;
          logger.warn({ sessionId: id, statusCode }, "Repeated pairing restart blocked; explicit retry required");
          return;
        }

        if (restartRequired) {
          // Pairing requires a new socket even before registered becomes true.
          // Use the normal single-flight scheduler and the same persisted auth path.
          session.status = "starting";
          session.pairingRestartPending = true;
          session.reconnectAttempts = 0;
          logger.info({ sessionId: id, statusCode }, "WhatsApp pairing completed; restart required");
          try { sock.end(undefined); } catch {
            logger.debug({ sessionId: id }, "Pairing socket was already closed");
          }
          scheduleReconnect(id, false);
          return;
        }

        session.status = "disconnected";
        if (badSession) {
          logger.warn({ sessionId: id, statusCode }, "WhatsApp reported badSession; credentials preserved and recovery will be attempted");
        }

        if (previouslyConnected) {
          scheduleReconnect(id, false, 3000);
        } else {
          session.status = "error";
          session.pairingRestartPending = false;
          session.reconnectAttempts = 0;
          logger.info({ sessionId: id, statusCode }, "Unregistered WhatsApp session closed; waiting for explicit pairing instead of reconnect loop");
        }
      }`,
  "connection-close recovery policy",
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

  const deadline = Date.now() + 15000;
  const connecting = connectSession(id, false);
  const generation = session.generation;
  await connecting;
  if (session.generation !== generation) return;
  const status = await waitForQrOrConnected(id, Math.max(0, deadline - Date.now()));
  if (status === "error") throw new Error("Could not initialize WhatsApp session");
}`,
  "non-destructive session start recovery",
);

replaceOnce(
`  session.starting = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(authPathFor(id));`,
`  const starting = session.starting = (async () => {
    if (session.pairingRestartPending && session.pendingCredsSave) {
      logger.info({ sessionId: id }, "Waiting for pending credential persistence before restart");
    }
    // The lock is assigned before this await, so /start and timers share it.
    // A failed write aborts reconnect; never load fresh/partial credentials.
    if (forceFresh) await session.pendingCredsSave?.catch(() => {});
    else await session.pendingCredsSave;
    if (!isCurrent()) return;
    if (forceFresh) await clearAuthState(id);
    if (!isCurrent()) return;
    const { state, saveCreds } = await useMultiFileAuthState(authPathFor(id));
    if (!isCurrent()) return;
    let previouslyConnected = Boolean(state.creds.registered || state.creds.me?.id);
    // Baileys also persists Signal keys outside creds.update. Drain both queues
    // before deleting auth, and reject writes from a superseded socket.
    const setKeys = state.keys.set.bind(state.keys);
    state.keys.set = (data) => {
      if (!isCurrent() || !session.sock) return Promise.resolve();
      const pending = (session.pendingCredsSave || Promise.resolve())
        .catch(() => {}).then(() => setKeys(data));
      session.pendingCredsSave = pending;
      return pending;
    };`,
  "credential persistence barrier",
);

replaceOnce(
`    const version = await resolveWhatsAppWebVersion();
    const sock = makeWASocket({`,
`    const version = await resolveWhatsAppWebVersion();
    if (!isCurrent()) return;
    if (session.pairingRestartPending) {
      logger.info({ sessionId: id }, "Restarting WhatsApp socket after successful pairing");
    }
    const sock = makeWASocket({`,
  "pairing socket restart",
);

replaceOnce(
`    sock.ev.on("creds.update", saveCreds);`,
`    logger.info({ sessionId: id, generation }, "WhatsApp socket created");
    const persistCreds = () => {
      if (session.sock !== sock) return;
      // Serialize full-state writes. A later update can retry a failed save.
      const pending = (session.pendingCredsSave || Promise.resolve())
        .catch(() => {})
        .then(() => saveCreds());
      session.pendingCredsSave = pending;
      void pending.catch(() => {
        logger.error({ sessionId: id }, "WhatsApp credential persistence failed; reconnect blocked until credentials are saved");
      });
    };
    sock.ev.on("creds.update", persistCreds);`,
  "serialized credential persistence",
);

replaceOnce(
`async function logoutSession(id: string) {
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
}`,
`async function logoutSession(id: string) {
  const session = getOrCreateSession(id);
  if (session.loggingOut) return session.loggingOut;
  const sock = session.sock;
  const starting = session.starting;
  session.generation = (session.generation || 0) + 1;
  manualLogouts.add(id);
  if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = undefined; }
  session.sock = undefined;
  session.starting = undefined;
  session.qr = undefined;
  session.qrDataUrl = undefined;
  session.phone = undefined;
  session.status = "logged_out";
  session.pairingRestartPending = false;
  session.reconnectAttempts = 0;
  logger.info({ sessionId: id, generation: session.generation }, "WhatsApp logout started");
  const cleanup = session.loggingOut = Promise.resolve().then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (sock) await Promise.race([
        sock.logout(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); }),
      ]);
    } catch {
      logger.warn({ sessionId: id }, "WhatsApp logout returned an error");
    } finally {
      if (timer) clearTimeout(timer);
      try { sock?.end(undefined); } catch {}
    }
    // These are captured old-generation operations. New starts await loggingOut.
    await starting?.catch(() => {});
    await session.pendingCredsSave?.catch(() => {});
    await clearAuthState(id);
    session.pendingCredsSave = undefined;
    logger.info({ sessionId: id, generation: session.generation }, "WhatsApp logout completed");
  });
  try { await cleanup; } finally {
    if (session.loggingOut === cleanup) {
      session.loggingOut = undefined;
      manualLogouts.delete(id);
    }
  }
}`,
  "generation-owned manual logout",
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

if (!current.includes("// Drain queued credential writes before the process exits.")) {
  replaceOnce(listenBlock, gracefulBlock, "graceful shutdown handler");
}

replaceOnce(
`  // Give pending credential writes and socket close frames a brief chance to flush.
  await new Promise((resolve) => setTimeout(resolve, 500));`,
`  // Drain queued credential writes before the process exits.
  await Promise.allSettled([...sessions.values()].map((session) => session.pendingCredsSave));
  // Give socket close frames a brief chance to flush.
  await new Promise((resolve) => setTimeout(resolve, 500));`,
  "shutdown credential persistence",
);

replaceOnce(
  `  try { await session.starting; } finally { session.starting = undefined; }`,
  `  try { await starting; } catch (error) {
    if (isCurrent()) session.status = "error";
    throw error;
  } finally {
    if (session.starting === starting) session.starting = undefined;
  }`,
  "generation-owned initialization completion",
);

replaceOnce(
  `          session.qrDataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 2, width: 420 });`,
  `          session.qrDataUrl = undefined;
          const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 2, width: 420 });
          if (!isCurrent() || session.sock !== sock || session.qr !== qr || session.status !== "qr") return;
          session.qrDataUrl = dataUrl;`,
  "QR encoding ownership",
);
replaceOnce(
  `        } catch (error) {
          session.status = "error";
          logger.error({ error, sessionId: id }, "Failed to generate QR data URL");`,
  `        } catch (error) {
          if (!isCurrent() || session.sock !== sock || session.qr !== qr || session.status !== "qr") return;
          session.status = "error";
          session.qr = undefined;
          session.qrDataUrl = undefined;
          session.sock = undefined;
          try { sock.end(undefined); } catch {}
          logger.error({ sessionId: id }, "Failed to generate QR data URL");`,
  "QR encoding error ownership",
);
replaceOnce(
  `  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.status === "qr" || session.status === "connected" || session.status === "error") return session.status;`,
  `  const generation = session.generation;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.generation !== generation) return session.status;
    if ((session.status === "qr" && session.qrDataUrl) || session.status === "connected" || session.status === "error" || session.status === "logged_out" || session.status === "disconnected") return session.status;`,
  "generation-owned start wait",
);
replaceOnce(
  `    session.status = "error";
    logger.error({ error: error?.message || error, sessionId }, "Could not start session");`,
  `    // The operation owns its state changes; a stale HTTP request does not.
    logger.error({ error: error?.message || error, sessionId }, "Could not start session");`,
  "stale HTTP error ownership",
);
replaceOnce(
  `    logger.error({ error, sessionId: id }, "Failed to clear WhatsApp auth state");`,
  `    logger.error({ sessionId: id }, "Failed to clear WhatsApp auth state");
    throw error;`,
  "auth cleanup error propagation",
);

if (changed) {
  writeFileSync(serverPath, current, "utf8");
  console.log("Patched production-grade WhatsApp session resilience");
} else {
  console.log("Production WhatsApp session resilience is already present in src/server.ts");
}
