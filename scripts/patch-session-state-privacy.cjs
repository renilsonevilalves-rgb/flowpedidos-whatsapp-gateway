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
  `const logger = pino({ level: process.env.LOG_LEVEL || "info" });`,
  `const SENSITIVE_LOG_PATHS = [
  "phone", "remoteJid", "jid", "pnJid", "targetJid", "text", "message",
  "menuUrl", "storeInfo", "code", "qr", "qrDataUrl", "auth", "creds", "keys",
  "node", "helloMsg", "handshake", "privateKey", "privKey", "rootKey",
  "ephemeralKeyPair", "accessToken", "refreshToken", "token",
  "*.phone", "*.remoteJid", "*.jid", "*.pnJid", "*.targetJid", "*.text",
  "*.message", "*.menuUrl", "*.storeInfo", "*.code", "*.qr", "*.qrDataUrl",
  "*.auth", "*.creds", "*.keys", "*.node", "*.helloMsg", "*.handshake",
  "*.privateKey", "*.privKey", "*.rootKey", "*.ephemeralKeyPair",
  "*.accessToken", "*.refreshToken", "*.token",
];

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: { paths: SENSITIVE_LOG_PATHS, censor: "[REDACTED]" },
});
const baileysLogger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || "warn",
  redact: { paths: SENSITIVE_LOG_PATHS, censor: "[REDACTED]" },
});

// libsignal used by Baileys writes complete Signal session objects directly to
// console.log/info. Those objects contain private ratchet material and bypass
// Pino redaction entirely, so suppress only those known session dumps.
const originalConsoleLog = console.log.bind(console);
const originalConsoleInfo = console.info.bind(console);
function isSensitiveSignalSessionDump(args: unknown[]) {
  const first = typeof args[0] === "string" ? args[0] : "";
  return /^(Closing (?:stale open |open )?session\\b|Removing old closed session\\b)/.test(first);
}
console.log = (...args: unknown[]) => {
  if (isSensitiveSignalSessionDump(args)) return;
  originalConsoleLog(...args);
};
console.info = (...args: unknown[]) => {
  if (isSensitiveSignalSessionDump(args)) return;
  originalConsoleInfo(...args);
};`,
  "privacy-safe logger initialization",
);

replaceOnce(
  `      logger: logger.child({ sessionId: id }),`,
  `      logger: baileysLogger.child({ sessionId: id }),`,
  "Baileys logger isolation",
);

replaceOnce(
  `async function fetchStoreInfo(sessionId: string) {`,
  `function getPublicSessionState(session: Session) {
  const connected = session.status === "connected" && Boolean(session.sock);
  const status: SessionStatus = session.status === "connected" && !session.sock
    ? "disconnected"
    : session.status;

  return {
    status,
    phone: connected ? session.phone || null : null,
    hasQr: Boolean(session.qrDataUrl),
    requiresPairing: status === "logged_out",
    reason: status === "logged_out" ? "pairing_required" : null,
  };
}

async function fetchStoreInfo(sessionId: string) {`,
  "public session state helper",
);

replaceOnce(
  `  res.json({ id: session.id, status: session.status, phone: session.phone || null, hasQr: Boolean(session.qrDataUrl) });`,
  `  res.json({ id: session.id, ...getPublicSessionState(session) });`,
  "status endpoint state normalization",
);

replaceOnce(
  `    res.json({ ok: true, id: session.id, status: session.status, phone: session.phone || null, hasQr: Boolean(session.qrDataUrl) });`,
  `    res.json({ ok: true, id: session.id, ...getPublicSessionState(session) });`,
  "start endpoint state normalization",
);

replaceOnce(
  `  const session = getOrCreateSession(sessionId);\n  if (session.status !== "connected" || !session.sock) {\n    res.status(409).json({ ok: false, error: "O WhatsApp da loja não está conectado.", status: session.status });\n    return;\n  }`,
  `  const session = getOrCreateSession(sessionId);\n  const publicState = getPublicSessionState(session);\n  if (publicState.status !== "connected" || !session.sock) {\n    res.status(409).json({\n      ok: false,\n      error: publicState.requiresPairing\n        ? "O WhatsApp da loja precisa ser conectado novamente."\n        : "O WhatsApp da loja não está conectado.",\n      ...publicState,\n    });\n    return;\n  }`,
  "send endpoint state normalization",
);

replaceOnce(
  `  if (!session.qrDataUrl) { res.status(404).json({ ok: false, error: "QR code not available", status: session.status }); return; }\n  res.json({ ok: true, status: session.status, qrDataUrl: session.qrDataUrl });`,
  `  if (!session.qrDataUrl) {\n    res.status(404).json({ ok: false, error: "QR code not available", ...getPublicSessionState(session) });\n    return;\n  }\n  res.json({ ok: true, ...getPublicSessionState(session), qrDataUrl: session.qrDataUrl });`,
  "QR endpoint state normalization",
);

if (changed) {
  writeFileSync(serverPath, current, "utf8");
  console.log("Patched WhatsApp public session state consistency and log privacy");
} else {
  console.log("WhatsApp public session state consistency and log privacy are already present in src/server.ts");
}
