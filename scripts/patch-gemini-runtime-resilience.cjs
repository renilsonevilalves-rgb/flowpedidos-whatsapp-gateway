const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const aiPath = resolve(__dirname, "../src/aiAssistant.ts");
let current = readFileSync(aiPath, "utf8");

if (!current.includes("[AI-Assistant] Gemini transient failure; retry scheduled")) {
  throw new Error("Gemini base resilience patch must run before runtime fallback patch");
}

if (!current.includes("const GEMINI_FALLBACK_MODEL =")) {
  const constantsOriginal = `const GEMINI_REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.GEMINI_TIMEOUT_MS || 10000));\nconst GEMINI_MAX_ATTEMPTS = 2;`;
  const constantsPatched = `const GEMINI_REQUEST_TIMEOUT_MS = Math.max(3500, Number(process.env.GEMINI_TIMEOUT_MS || 6500));\nconst GEMINI_FALLBACK_MODEL = String(process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite").trim();\nconst GEMINI_MAX_ATTEMPTS = 2;`;

  if (!current.includes(constantsOriginal)) {
    throw new Error("Could not locate Gemini retry constants");
  }
  current = current.replace(constantsOriginal, constantsPatched);

  const generationOriginal = `    generationConfig: {\n      temperature: 0.15,\n      maxOutputTokens: 260,\n      responseMimeType: "application/json",\n    },`;
  const generationPatched = `    generationConfig: {\n      thinkingConfig: { thinkingLevel: "minimal" },\n      maxOutputTokens: 260,\n      responseMimeType: "application/json",\n    },`;

  if (!current.includes(generationOriginal)) {
    throw new Error("Could not locate Gemini generationConfig");
  }
  current = current.replace(generationOriginal, generationPatched);

  const loopOriginal = `  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {\n    const controller = new AbortController();`;
  const loopPatched = `  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {\n    const model = attempt === 1 ? GEMINI_MODEL : (GEMINI_FALLBACK_MODEL || GEMINI_MODEL);\n    const controller = new AbortController();`;

  if (!current.includes(loopOriginal)) {
    throw new Error("Could not locate Gemini retry loop");
  }
  current = current.replace(loopOriginal, loopPatched);

  const requestStart = current.indexOf("async function requestGemini(");
  const requestEnd = current.indexOf("\n\nasync function postBackend", requestStart);
  if (requestStart < 0 || requestEnd < 0) {
    throw new Error("Could not isolate requestGemini implementation");
  }

  let requestBlock = current.slice(requestStart, requestEnd);
  const urlOriginal = "${encodeURIComponent(GEMINI_MODEL)}:generateContent";
  const urlPatched = "${encodeURIComponent(model)}:generateContent";
  if (!requestBlock.includes(urlOriginal)) {
    throw new Error("Could not locate Gemini model in request URL");
  }
  requestBlock = requestBlock.replace(urlOriginal, urlPatched);
  requestBlock = requestBlock.replaceAll("model: GEMINI_MODEL,", "model,");
  requestBlock = requestBlock.replace(
    `      if (response.ok) {\n        return parseAiDecision(extractGeminiText(data));\n      }`,
    `      if (response.ok) {\n        logger.info({ sessionId, model, attempt }, "[AI-Assistant] Gemini request succeeded");\n        return parseAiDecision(extractGeminiText(data));\n      }`,
  );

  current = current.slice(0, requestStart) + requestBlock + current.slice(requestEnd);
}

if (!current.includes("[AI-Assistant] Gemini unavailable; safe fallback reply sent")) {
  const noDecisionOriginal = `    if (!decision) return false;`;
  const noDecisionPatched = `    if (!decision) {\n      const fallbackMenuUrl = clean(storeInfo?.menuUrl);\n      const fallbackReply = fallbackMenuUrl\n        ? \`Oi! 😊 Para confirmar se temos esse item disponível agora, dá uma olhadinha no nosso cardápio digital: \${fallbackMenuUrl}\`\n        : "Oi! 😊 Não consegui confirmar isso agora. Tente novamente em instantes ou fale com a loja.";\n      await sendText(params, fallbackReply);\n      params.logger.warn(\n        { sessionId: params.sessionId, remoteJid: params.customerJid },\n        "[AI-Assistant] Gemini unavailable; safe fallback reply sent",\n      );\n      return true;\n    }`;

  if (!current.includes(noDecisionOriginal)) {
    throw new Error("Could not locate Gemini no-decision fallback");
  }
  current = current.replace(noDecisionOriginal, noDecisionPatched);
}

writeFileSync(aiPath, current, "utf8");
console.log("Patched Gemini low-latency model resilience and natural safe fallback");
