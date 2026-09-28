const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
const aiAssistantPath = resolve(__dirname, "../src/aiAssistant.ts");
let current = readFileSync(serverPath, "utf8");
let aiAssistant = readFileSync(aiAssistantPath, "utf8");
let changed = false;
let aiChanged = false;

function replaceOnce(original, replacement, label) {
  if (current.includes(replacement)) return;
  if (!current.includes(original)) {
    throw new Error(`Could not locate ${label} in src/server.ts`);
  }
  current = current.replace(original, replacement);
  changed = true;
}

function removeOnce(original, label) {
  if (!current.includes(original)) return;
  current = current.replace(original, "");
  changed = true;
  console.log(`Removed ${label} from src/server.ts`);
}

function replaceAiOnce(original, replacement, label) {
  if (aiAssistant.includes(replacement)) return;
  if (!aiAssistant.includes(original)) {
    throw new Error(`Could not locate ${label} in src/aiAssistant.ts`);
  }
  aiAssistant = aiAssistant.replace(original, replacement);
  aiChanged = true;
}

function replaceAiRange(startMarker, endMarker, replacement, label, alreadyMarker) {
  if (aiAssistant.includes(alreadyMarker)) return;
  const start = aiAssistant.indexOf(startMarker);
  const end = aiAssistant.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Could not locate ${label} in src/aiAssistant.ts`);
  }
  aiAssistant = aiAssistant.slice(0, start) + replacement + aiAssistant.slice(end);
  aiChanged = true;
}

replaceAiOnce(
  `  const orders = Array.isArray(lookup?.data?.orders) ? lookup.data.orders as OrderSummary[] : [];`,
  `  const lookupOrdersData = (lookup as any)?.data?.orders;\n  const orders = Array.isArray(lookupOrdersData) ? lookupOrdersData as OrderSummary[] : [];`,
  "AI backend lookup result typing",
);

replaceAiOnce(
  `const REQUEST_TIMEOUT_MS = 8000;`,
  `const REQUEST_TIMEOUT_MS = 8000;\nconst GEMINI_REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.GEMINI_TIMEOUT_MS || 10000));\nconst GEMINI_MAX_ATTEMPTS = 2;`,
  "Gemini retry settings",
);

const resilientGeminiRequest = [
  `async function requestGemini(text: string, storeInfo: StoreInfo, logger: Logger, sessionId: string) {`,
  `  if (!GEMINI_API_KEY || !GEMINI_MODEL) return null;`,
  ``,
  `  const requestBody = JSON.stringify({`,
  `    system_instruction: {`,
  `      parts: [{ text: buildAiSystemInstruction(storeInfo) }],`,
  `    },`,
  `    contents: [{`,
  `      role: "user",`,
  `      parts: [{ text: text.slice(0, MAX_CUSTOMER_TEXT) }],`,
  `    }],`,
  `    generationConfig: {`,
  `      temperature: 0.15,`,
  `      maxOutputTokens: 260,`,
  `      responseMimeType: "application/json",`,
  `    },`,
  `  });`,
  `  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);`,
  ``,
  `  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {`,
  `    const controller = new AbortController();`,
  `    const timer = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);`,
  `    let shouldRetry = false;`,
  ``,
  `    try {`,
  `      const response = await fetch(`,
  '        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,',
  `        {`,
  `          method: "POST",`,
  `          headers: {`,
  `            "Content-Type": "application/json",`,
  `            "x-goog-api-key": GEMINI_API_KEY,`,
  `          },`,
  `          body: requestBody,`,
  `          signal: controller.signal,`,
  `        },`,
  `      );`,
  ``,
  `      const data = await response.json().catch(() => ({}));`,
  `      if (response.ok) {`,
  `        return parseAiDecision(extractGeminiText(data));`,
  `      }`,
  ``,
  `      shouldRetry = retryableStatuses.has(response.status) && attempt < GEMINI_MAX_ATTEMPTS;`,
  `      logger.warn(`,
  `        {`,
  `          sessionId,`,
  `          status: response.status,`,
  `          model: GEMINI_MODEL,`,
  `          attempt,`,
  `          maxAttempts: GEMINI_MAX_ATTEMPTS,`,
  `          providerError: clean(data?.error?.status || data?.error?.message).slice(0, 160) || undefined,`,
  `        },`,
  `        shouldRetry`,
  `          ? "[AI-Assistant] Gemini transient failure; retry scheduled"`,
  `          : "[AI-Assistant] Gemini request failed; legacy fallback remains available",`,
  `      );`,
  ``,
  `      if (!shouldRetry) return null;`,
  `    } catch (error: any) {`,
  `      const transient = error?.name === "AbortError" || error?.name === "TimeoutError" || error instanceof TypeError;`,
  `      shouldRetry = transient && attempt < GEMINI_MAX_ATTEMPTS;`,
  `      logger.warn(`,
  `        {`,
  `          sessionId,`,
  `          model: GEMINI_MODEL,`,
  `          attempt,`,
  `          maxAttempts: GEMINI_MAX_ATTEMPTS,`,
  `          error: error?.message || error,`,
  `        },`,
  `        shouldRetry`,
  `          ? "[AI-Assistant] Gemini transient error; retry scheduled"`,
  `          : "[AI-Assistant] Gemini request failed; legacy fallback remains available",`,
  `      );`,
  `      if (!shouldRetry) return null;`,
  `    } finally {`,
  `      clearTimeout(timer);`,
  `    }`,
  ``,
  `    const backoffMs = 450 * attempt + Math.floor(Math.random() * 250);`,
  `    await new Promise((resolve) => setTimeout(resolve, backoffMs));`,
  `  }`,
  ``,
  `  return null;`,
  `}`,
].join("\n");

replaceAiRange(
  `async function requestGemini(text: string, storeInfo: StoreInfo, logger: Logger, sessionId: string) {`,
  `\n\nasync function postBackend`,
  resilientGeminiRequest,
  "Gemini request implementation",
  "[AI-Assistant] Gemini transient failure; retry scheduled",
);

replaceOnce(
  `} from "@whiskeysockets/baileys";\n\nconst PORT`,
  `} from "@whiskeysockets/baileys";\nimport { handleAiAssistantMessage } from "./aiAssistant.js";\n\nconst PORT`,
  "AI assistant import",
);

replaceOnce(
  `      if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us")) continue;`,
  `      if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us") || remoteJid.endsWith("@newsletter")) continue;`,
  "WhatsApp newsletter filter",
);

removeOnce(
  `const userLastReply = new Map<string, number>();\n`,
  "4-hour auto-reply state",
);

removeOnce(
  `      const lastReplyTime = userLastReply.get(userKey) || 0;\n      const fourHours = 1000 * 60 * 60 * 4;\n\n      if (Date.now() - lastReplyTime <= fourHours) {\n        logger.info({ sessionId: id, remoteJid: customerJid }, "[Auto-Reply] 4-hour cooldown active; message ignored");\n        continue;\n      }\n\n`,
  "4-hour greeting cooldown",
);

removeOnce(
  `        userLastReply.set(userKey, Date.now());\n`,
  "4-hour greeting cooldown timestamp",
);

replaceOnce(
  `      const isTrigger = isAutoReplyTrigger(text);\n      if (!isTrigger) continue;`,
  `      const isTrigger = isAutoReplyTrigger(text);\n\n      // Saudações/pedidos de cardápio são determinísticos e devem responder imediatamente.\n      // O Gemini atende apenas mensagens fora desse fluxo para não atrasar nem engolir o link do cardápio.\n      if (!isTrigger) {\n        const aiCustomerJid = getCustomerJid(msg, remoteJid);\n        const aiCustomerPhone = await resolveCustomerPhone(sock, msg, remoteJid);\n        const aiHandled = await handleAiAssistantMessage({\n          sessionId: id,\n          customerJid: aiCustomerJid,\n          customerPhone: aiCustomerPhone,\n          text,\n          getStoreInfo: async () => fetchStoreInfo(id),\n          sendMessage: async (jid, content) => { await sock.sendMessage(jid, content); },\n          logger,\n        });\n        if (aiHandled) continue;\n      }\n\n      if (!isTrigger) continue;`,
  "AI assistant incoming-message hook",
);

if (current.includes("4-hour cooldown active") || current.includes("userLastReply")) {
  throw new Error("4-hour greeting cooldown is still present after WhatsApp patch");
}
if (!current.includes('remoteJid.endsWith("@newsletter")')) {
  throw new Error("WhatsApp newsletter filter was not applied");
}
if (!current.includes("if (!isTrigger) {") || !current.includes("handleAiAssistantMessage")) {
  throw new Error("Gemini routing guard was not applied");
}

if (aiChanged) {
  writeFileSync(aiAssistantPath, aiAssistant, "utf8");
}
if (changed) {
  writeFileSync(serverPath, current, "utf8");
}

if (changed || aiChanged) {
  console.log("Patched WhatsApp greeting priority, Gemini resilience and incoming-message filters");
} else {
  console.log("WhatsApp/Gemini patch is already present");
}
