const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
const current = readFileSync(serverPath, "utf8");
const patchedNeedle = "      syncFullHistory: false,\n      shouldSyncHistoryMessage: () => false,\n      shouldIgnoreJid:";
const originalNeedle = "      syncFullHistory: false,\n      shouldIgnoreJid:";

if (current.includes(patchedNeedle)) {
  console.log("History sync is already disabled in src/server.ts");
  process.exit(0);
}

if (!current.includes(originalNeedle)) {
  throw new Error("Could not locate the Baileys history-sync configuration in src/server.ts");
}

const updated = current.replace(originalNeedle, patchedNeedle);
writeFileSync(serverPath, updated, "utf8");
console.log("Disabled Baileys history synchronization to prevent gateway OOM crashes");
