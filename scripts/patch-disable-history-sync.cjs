const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
const current = readFileSync(serverPath, "utf8");

const safeHistoryConfig = `      syncFullHistory: false,
      shouldSyncHistoryMessage: ({ syncType, fileLength }) => {
        // Keep the Baileys initial-sync handshake alive without downloading
        // message-heavy history. PUSH_NAME (4) and NON_BLOCKING_DATA (5)
        // carry lightweight contact/LID metadata needed for stable inbound DMs.
        // A synthetic RECENT probe has no fileLength and is allowed only so
        // Baileys does not disable initial synchronization entirely.
        if (syncType === 3 && fileLength == null) return true;
        return syncType === 4 || syncType === 5;
      },
      shouldIgnoreJid:`;

const fullyDisabledConfig = `      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid:`;

const originalConfig = `      syncFullHistory: false,
      shouldIgnoreJid:`;

if (current.includes(safeHistoryConfig)) {
  console.log("Safe WhatsApp metadata sync is already configured in src/server.ts");
  process.exit(0);
}

let updated;
if (current.includes(fullyDisabledConfig)) {
  updated = current.replace(fullyDisabledConfig, safeHistoryConfig);
} else if (current.includes(originalConfig)) {
  updated = current.replace(originalConfig, safeHistoryConfig);
} else {
  throw new Error("Could not locate the Baileys history-sync configuration in src/server.ts");
}

writeFileSync(serverPath, updated, "utf8");
console.log("Enabled lightweight WhatsApp LID metadata sync while blocking heavy message history");
