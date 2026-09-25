const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
let current = readFileSync(serverPath, "utf8");
let changed = false;

const fsImportOriginal = `import { rm } from "node:fs/promises";`;
const fsImportPatched = `import { readFile, readdir, rm } from "node:fs/promises";`;

if (!current.includes(fsImportPatched)) {
  if (!current.includes(fsImportOriginal)) {
    throw new Error("Could not locate node:fs/promises import in src/server.ts");
  }
  current = current.replace(fsImportOriginal, fsImportPatched);
  changed = true;
}

const listenOriginal = `app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT, dataDir: DATA_DIR, frontendConfigured: Boolean(FRONTEND_URL) }, "FlowPedidos WhatsApp Gateway started");
});`;

const listenPatched = `async function restorePersistedSessions() {
  try {
    const entries = await readdir(DATA_DIR, { withFileTypes: true });
    const sessionIds = entries
      .filter((entry) => entry.isDirectory() && safeSessionId(entry.name))
      .map((entry) => entry.name);

    let registeredSessions = 0;
    let restored = 0;
    for (const sessionId of sessionIds) {
      try {
        const rawCreds = await readFile(join(authPathFor(sessionId), "creds.json"), "utf8");
        const persistedCreds = JSON.parse(rawCreds);
        if (!persistedCreds?.registered) continue;
        registeredSessions += 1;
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          logger.warn({ error: error?.message || error, sessionId }, "Skipping unreadable persisted WhatsApp credentials");
        }
        continue;
      }

      const session = getOrCreateSession(sessionId);
      if (session.starting || session.sock) continue;

      try {
        await connectSession(sessionId, false);
        restored += 1;
      } catch (error: any) {
        logger.error({ error: error?.message || error, sessionId }, "Failed to restore persisted WhatsApp session");
      }
    }

    logger.info({ persistedSessions: sessionIds.length, registeredSessions, restoreAttempts: restored }, "Persisted WhatsApp session restore completed");
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      logger.info({ dataDir: DATA_DIR }, "No persisted WhatsApp session directory found yet");
      return;
    }
    logger.error({ error: error?.message || error }, "Failed to enumerate persisted WhatsApp sessions");
  }
}

app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT, dataDir: DATA_DIR, frontendConfigured: Boolean(FRONTEND_URL) }, "FlowPedidos WhatsApp Gateway started");
  void restorePersistedSessions();
});`;

if (!current.includes(listenPatched)) {
  if (!current.includes(listenOriginal)) {
    throw new Error("Could not locate app.listen block in src/server.ts");
  }
  current = current.replace(listenOriginal, listenPatched);
  changed = true;
}

if (changed) {
  writeFileSync(serverPath, current, "utf8");
  console.log("Patched restoration of registered persisted WhatsApp sessions on gateway startup");
} else {
  console.log("Registered WhatsApp session restoration is already present in src/server.ts");
}
