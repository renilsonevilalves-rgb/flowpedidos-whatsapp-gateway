// src/audioTranscription.ts
// Voice notes become text for the same AI flow. Disabled with
// WHATSAPP_AUDIO_TRANSCRIPTION=false. Never throws: on failure returns "".
type Log = { warn: (details: Record<string, unknown>, message: string) => void; info: (details: Record<string, unknown>, message: string) => void };

const MAX_SECONDS = Number(process.env.WHATSAPP_AUDIO_MAX_SECONDS || 120);
const MAX_BYTES = 4 * 1024 * 1024;

function audioOf(message: any): any {
  let current = message;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current.audioMessage) return current.audioMessage;
    current = current.ephemeralMessage?.message || current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message || current.documentWithCaptionMessage?.message;
  }
  return null;
}

export function hasAudio(message: any): boolean {
  return Boolean(audioOf(message));
}

export async function transcribeIncomingAudio(msg: any, logger: Log, sessionId: string): Promise<string> {
  const audio = audioOf(msg?.message);
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!audio || !apiKey || process.env.WHATSAPP_AUDIO_TRANSCRIPTION === "false") return "";
  if (Number(audio.seconds) > MAX_SECONDS) return "";
  try {
    const baileys: any = await import("@whiskeysockets/baileys");
    const buffer: any = await baileys.downloadMediaMessage(msg, "buffer", {});
    if (!buffer?.length || buffer.length > MAX_BYTES) return "";
    const mimeType = String(audio.mimetype || "audio/ogg").split(";")[0] || "audio/ogg";
    const models = [String(process.env.GEMINI_MODEL || "gemini-3.1-flash-lite"), String(process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite")]
      .filter((value, index, all) => value && all.indexOf(value) === index);
    for (const model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [
              { text: "Transcreva fielmente este áudio de um cliente falando com um delivery, em português do Brasil. Responda SOMENTE com a transcrição, sem comentários. Se não houver fala compreensível, responda vazio." },
              { inline_data: { mime_type: mimeType, data: Buffer.from(buffer).toString("base64") } },
            ] }],
            generationConfig: { temperature: 0, maxOutputTokens: 400 },
          }),
        });
        if (!response.ok) { logger.warn({ sessionId, model, status: response.status }, "[Audio] Transcription failed"); continue; }
        const data: any = await response.json().catch(() => ({}));
        const text = (data?.candidates?.[0]?.content?.parts || []).map((part: any) => String(part?.text || "")).join(" ")
          .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500);
        if (text) { logger.info({ sessionId, seconds: audio.seconds }, "[Audio] Voice note transcribed"); return text; }
        return "";
      } catch (error: any) {
        logger.warn({ sessionId, model, error: error?.name || "request" }, "[Audio] Transcription error");
      } finally { clearTimeout(timer); }
    }
  } catch (error: any) {
    logger.warn({ sessionId, error: error?.message || error }, "[Audio] Download failed");
  }
  return "";
}
