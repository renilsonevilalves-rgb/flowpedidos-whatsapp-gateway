// Ritmo natural de resposta: mostra "digitando..." e espera um tempo proporcional
// ao tamanho do texto antes de enviar. Evita respostas instantâneas e em rajada.
// Nunca lança erro: se a presença falhar, a mensagem segue normalmente.

const MIN_MS = Number(process.env.WHATSAPP_TYPING_MIN_MS || 1200);
const MAX_MS = Number(process.env.WHATSAPP_TYPING_MAX_MS || 4000);
const ENABLED = process.env.WHATSAPP_TYPING_INDICATOR !== "false";

export function typingDelayMs(text: string, random = Math.random) {
  const length = String(text || "").length;
  const base = 800 + length * 18;
  const jitter = Math.floor(random() * 600);
  return Math.max(MIN_MS, Math.min(MAX_MS, base + jitter));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function showTypingThenWait(sock: any, jid: string, text: string) {
  if (!ENABLED || !sock || !jid || jid.endsWith("@g.us")) return;
  try {
    await sock.sendPresenceUpdate?.("composing", jid);
  } catch {
    // Presença é cosmética; nunca bloqueia o envio.
  }
  await sleep(typingDelayMs(text));
  try {
    await sock.sendPresenceUpdate?.("paused", jid);
  } catch {
    // idem
  }
}
