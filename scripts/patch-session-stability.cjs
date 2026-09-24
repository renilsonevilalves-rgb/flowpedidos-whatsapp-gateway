const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
let current = readFileSync(serverPath, "utf8");
let changed = false;

const messagesOriginal = `    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      await handleIncomingMessages(id, sock, messages, type);
    });`;

const messagesPatched = `    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      // Ignore events emitted by a socket that has already been replaced.
      // This prevents duplicate auto-replies and stale-session processing.
      if (session.sock !== sock) return;
      await handleIncomingMessages(id, sock, messages, type);
    });`;

if (!current.includes(messagesPatched)) {
  if (!current.includes(messagesOriginal)) {
    throw new Error("Could not locate WhatsApp messages.upsert listener in src/server.ts");
  }
  current = current.replace(messagesOriginal, messagesPatched);
  changed = true;
}

const connectionOriginal = `    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;`;

const connectionPatched = `    sock.ev.on("connection.update", async (update) => {
      // A previous socket can still emit close/open events after a replacement.
      // Never let those stale events clear or reconnect the current healthy socket.
      if (session.sock !== sock) {
        logger.debug({ sessionId: id }, "Ignoring connection update from stale WhatsApp socket");
        return;
      }
      const { connection, lastDisconnect, qr } = update;`;

if (!current.includes(connectionPatched)) {
  if (!current.includes(connectionOriginal)) {
    throw new Error("Could not locate WhatsApp connection.update listener in src/server.ts");
  }
  current = current.replace(connectionOriginal, connectionPatched);
  changed = true;
}

if (changed) {
  writeFileSync(serverPath, current, "utf8");
  console.log("Patched WhatsApp socket generation guards to prevent reconnect conflicts");
} else {
  console.log("WhatsApp socket generation guards are already present in src/server.ts");
}
