// Cliente do Gemini com "function calling". Qualquer falha (limite, fora do ar,
// demora) vira GeminiUnavailable para o atendente responder sem travar.

export class GeminiUnavailable extends Error {}

export type GeminiPart = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; [k: string]: unknown };
export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

const TIMEOUT_MS = Number(process.env.ATENDENTE_GEMINI_TIMEOUT_MS || 15_000);

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function generate(system: string, contents: GeminiContent[], tools: unknown[]): Promise<GeminiPart[]> {
  const apiKey = String(process.env.GEMINI_API_KEY || "");
  if (!apiKey) throw new GeminiUnavailable("GEMINI_API_KEY ausente");
  const primary = String(process.env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim();
  const fallback = String(process.env.GEMINI_FALLBACK_MODEL || "").trim();
  const models = [primary, fallback].filter((m, i, all) => m && all.indexOf(m) === i);
  let thinking = true;
  let lastError = "sem resposta";
  for (let attempt = 0; attempt < Math.max(2, models.length); attempt += 1) {
    const model = models[Math.min(attempt, models.length - 1)];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          signal: controller.signal,
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents,
            tools: [{ functionDeclarations: tools }],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 1024,
              ...(thinking ? { thinkingConfig: { thinkingLevel: process.env.ATENDENTE_THINKING_LEVEL || "low" } } : {}),
            },
          }),
        },
      );
      const data: any = await response.json().catch(() => ({}));
      if (response.ok) {
        const parts = data?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts) && parts.length) return parts;
        lastError = "resposta vazia";
        continue;
      }
      lastError = "HTTP " + response.status;
      // Modelo sem suporte a thinkingLevel: tenta de novo sem ele.
      if (response.status === 400 && thinking && /thinking/i.test(JSON.stringify(data))) { thinking = false; attempt -= 1; continue; }
      if (response.status === 400 || response.status === 401 || response.status === 403) break;
    } catch (error: any) {
      lastError = error?.name === "AbortError" ? "timeout" : String(error?.message || error);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new GeminiUnavailable(lastError);
}
