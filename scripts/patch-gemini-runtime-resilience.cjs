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

if (!current.includes("type StoreOpeningHour =")) {
  const storeInfoOriginal = `type StoreInfo = {\n  storeName?: string;\n  menuUrl?: string;\n  autoReplyMessage?: string;\n};`;
  const storeInfoPatched = `type StoreOpeningHour = {\n  enabled?: boolean;\n  open?: string;\n  close?: string;\n};\n\ntype StoreInfo = {\n  storeName?: string;\n  menuUrl?: string;\n  autoReplyMessage?: string;\n  openingHours?: Record<string, StoreOpeningHour> | null;\n  timezone?: string;\n  isOpen?: boolean | null;\n};`;

  if (!current.includes(storeInfoOriginal)) {
    throw new Error("Could not locate StoreInfo type for store-hours support");
  }
  current = current.replace(storeInfoOriginal, storeInfoPatched);
}

if (!current.includes("function buildStoreHoursReply(")) {
  const helperMarker = `export function normalizePaymentMethod(value: unknown): "pix" | "credit" | "money" | "" {`;
  const hoursHelpers = String.raw`const STORE_DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const STORE_DAY_LABELS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const STORE_DAY_PREFIXES = ["No domingo", "Na segunda-feira", "Na terça-feira", "Na quarta-feira", "Na quinta-feira", "Na sexta-feira", "No sábado"];
const STORE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isValidStoreSlot(value: StoreOpeningHour | undefined | null) {
  return Boolean(value?.enabled === true && STORE_TIME_PATTERN.test(clean(value?.open)) && STORE_TIME_PATTERN.test(clean(value?.close)) && value?.open !== value?.close);
}

function storeTimeToMinutes(value: unknown) {
  const text = clean(value);
  if (!STORE_TIME_PATTERN.test(text)) return -1;
  const [hour, minute] = text.split(":").map(Number);
  return hour * 60 + minute;
}

function isStoreHoursQuestion(value: unknown) {
  const text = normalizeForMatch(value);
  if (!text) return false;
  if (/\b(horario|horarios|funcionamento)\b/.test(text)) return true;
  if (/\b(que horas|qual hora|q horas|q hora)\b.*\b(abre|abrem|abrimos|fecha|fecham|fechamos)\b/.test(text)) return true;
  if (/\b(loja|voces|estabelecimento)\b.*\b(abre|abrem|fecha|fecham|aberto|aberta|fechado|fechada)\b/.test(text)) return true;
  if (/\b(abre|abrem|fecha|fecham|aberto|aberta|fechado|fechada)\b.*\b(hoje|amanha|domingo|segunda|terca|quarta|quinta|sexta|sabado)\b/.test(text)) return true;
  return false;
}

function isMenuFallbackQuestion(value: unknown) {
  const text = normalizeForMatch(value);
  if (!text) return false;
  return /\b(cardapio|menu|produto|produtos|preco|precos|valor|valores|vende|vendem|serve|servem|tem|pedido|pedir)\b/.test(text);
}

function getStoreLocalClock(timezone: string) {
  const fallbackTimezone = "America/Sao_Paulo";
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const weekday = clean(parts.find((part) => part.type === "weekday")?.value).toLowerCase();
    const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return { dayIndex: dayMap[weekday] ?? 0, minutes: Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0 };
  };
  try {
    return read(timezone || fallbackTimezone);
  } catch {
    return read(fallbackTimezone);
  }
}

function requestedStoreDay(text: string, currentDayIndex: number) {
  if (/\bamanha\b/.test(text)) return { dayIndex: (currentDayIndex + 1) % 7, prefix: "Amanhã" };
  if (/\bhoje\b/.test(text)) return { dayIndex: currentDayIndex, prefix: "Hoje" };
  const matchers = [
    /\bdomingo\b/,
    /\bsegunda(?:-feira)?\b/,
    /\bterca(?:-feira)?\b/,
    /\bquarta(?:-feira)?\b/,
    /\bquinta(?:-feira)?\b/,
    /\bsexta(?:-feira)?\b/,
    /\bsabado\b/,
  ];
  const explicitIndex = matchers.findIndex((pattern) => pattern.test(text));
  if (explicitIndex >= 0) return { dayIndex: explicitIndex, prefix: STORE_DAY_PREFIXES[explicitIndex] };
  return { dayIndex: currentDayIndex, prefix: "Hoje" };
}

function isWithinStoreSlot(minutes: number, slot: StoreOpeningHour) {
  if (!isValidStoreSlot(slot)) return false;
  const open = storeTimeToMinutes(slot.open);
  const close = storeTimeToMinutes(slot.close);
  if (open < close) return minutes >= open && minutes < close;
  return minutes >= open || minutes < close;
}

function currentStoreOpenSlot(hours: Record<string, StoreOpeningHour>, dayIndex: number, minutes: number) {
  const current = hours[STORE_DAY_KEYS[dayIndex]];
  if (current && isWithinStoreSlot(minutes, current)) return current;

  const previous = hours[STORE_DAY_KEYS[(dayIndex + 6) % 7]];
  if (isValidStoreSlot(previous)) {
    const open = storeTimeToMinutes(previous?.open);
    const close = storeTimeToMinutes(previous?.close);
    if (open > close && minutes < close) return previous;
  }
  return null;
}

function buildStoreHoursReply(value: unknown, storeInfo: StoreInfo) {
  if (!isStoreHoursQuestion(value)) return "";

  const text = normalizeForMatch(value);
  const timezone = clean(storeInfo.timezone) || "America/Sao_Paulo";
  const clock = getStoreLocalClock(timezone);
  const target = requestedStoreDay(text, clock.dayIndex);
  const hours = storeInfo.openingHours && typeof storeInfo.openingHours === "object" ? storeInfo.openingHours : {};
  const anyConfigured = STORE_DAY_KEYS.some((key) => isValidStoreSlot(hours[key]));
  const slot = hours[STORE_DAY_KEYS[target.dayIndex]];
  const asksClose = /\b(fecha|fecham|fechamos|fechamento)\b/.test(text);
  const asksOpen = /\b(abre|abrem|abrimos|abertura)\b/.test(text) && !asksClose;
  const asksStatus = /\b(aberto|aberta|fechado|fechada)\b/.test(text);

  if (asksStatus && target.dayIndex === clock.dayIndex) {
    if (!anyConfigured) {
      if (storeInfo.isOpen === true) return "Sim 😊 A loja está aberta no momento, mas o horário de funcionamento ainda não está configurado no sistema.";
      if (storeInfo.isOpen === false) return "No momento a loja está fechada, mas o horário de funcionamento ainda não está configurado no sistema.";
      return "Não consegui confirmar se a loja está aberta agora porque o horário de funcionamento ainda não está configurado.";
    }

    const openSlot = currentStoreOpenSlot(hours, clock.dayIndex, clock.minutes);
    if (openSlot) return "Sim 😊 A loja está aberta agora e fecha às " + clean(openSlot.close) + ".";
    if (isValidStoreSlot(slot)) return "No momento a loja está fechada. Hoje funcionamos das " + clean(slot?.open) + " às " + clean(slot?.close) + ".";
    return "No momento a loja está fechada. Hoje a loja não abre.";
  }

  if (!isValidStoreSlot(slot)) {
    if (!anyConfigured) {
      if (target.dayIndex === clock.dayIndex && storeInfo.isOpen === true) {
        return "Oi! 😊 A loja está aberta no momento, mas o horário de fechamento ainda não está configurado no sistema.";
      }
      if (target.dayIndex === clock.dayIndex && storeInfo.isOpen === false) {
        return "No momento a loja está fechada, e o horário de funcionamento ainda não está configurado no sistema.";
      }
      return "O horário de funcionamento ainda não está configurado no sistema.";
    }
    return target.prefix + ", a loja não abre.";
  }

  if (asksClose) return target.prefix + ", fechamos às " + clean(slot?.close) + ". 😊";
  if (asksOpen) return target.prefix + ", abrimos às " + clean(slot?.open) + ". 😊";
  return target.prefix + ", funcionamos das " + clean(slot?.open) + " às " + clean(slot?.close) + ". 😊";
}

`;

  if (!current.includes(helperMarker)) {
    throw new Error("Could not locate AI helper insertion point for store-hours support");
  }
  current = current.replace(helperMarker, hoursHelpers + helperMarker);
}

if (!current.includes("[AI-Assistant] Store hours reply sent")) {
  const storeInfoHookOriginal = `    const storeInfo = await params.getStoreInfo();\n    const decision = await requestGemini(text, storeInfo || {}, params.logger, params.sessionId);`;
  const storeInfoHookPatched = `    const storeInfo = await params.getStoreInfo();\n    const storeHoursReply = buildStoreHoursReply(text, storeInfo || {});\n    if (storeHoursReply) {\n      await sendText(params, storeHoursReply);\n      params.logger.info(\n        { sessionId: params.sessionId, remoteJid: params.customerJid },\n        "[AI-Assistant] Store hours reply sent",\n      );\n      return true;\n    }\n    const decision = await requestGemini(text, storeInfo || {}, params.logger, params.sessionId);`;

  if (!current.includes(storeInfoHookOriginal)) {
    throw new Error("Could not locate store-info hook for deterministic hours reply");
  }
  current = current.replace(storeInfoHookOriginal, storeInfoHookPatched);
}

if (!current.includes("[AI-Assistant] Gemini unavailable; safe fallback reply sent")) {
  const noDecisionOriginal = `    if (!decision) return false;`;
  const noDecisionPatched = `    if (!decision) {\n      const fallbackMenuUrl = clean(storeInfo?.menuUrl);\n      const fallbackReply = isMenuFallbackQuestion(text) && fallbackMenuUrl\n        ? \`Oi! 😊 Para confirmar se temos esse item disponível agora, dá uma olhadinha no nosso cardápio digital: \${fallbackMenuUrl}\`\n        : "Oi! 😊 Não consegui confirmar essa informação agora. Tente novamente em instantes ou fale com a loja.";\n      await sendText(params, fallbackReply);\n      params.logger.warn(\n        { sessionId: params.sessionId, remoteJid: params.customerJid },\n        "[AI-Assistant] Gemini unavailable; safe fallback reply sent",\n      );\n      return true;\n    }`;

  if (!current.includes(noDecisionOriginal)) {
    throw new Error("Could not locate Gemini no-decision fallback");
  }
  current = current.replace(noDecisionOriginal, noDecisionPatched);
}

writeFileSync(aiPath, current, "utf8");
console.log("Patched Gemini resilience, deterministic store-hours replies and natural safe fallback");
