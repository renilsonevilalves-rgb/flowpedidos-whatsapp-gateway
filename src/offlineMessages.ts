// Mensagens que o cliente mandou enquanto a conexão da loja estava fora do ar
// (reinício, atualização, queda) chegam depois como "append" e antes eram ignoradas:
// o cliente ficava sem resposta. Aqui escolhemos quais delas ainda merecem resposta.
//
// Regras:
// - Só mensagens de cliente em conversa individual (sem grupo, status ou canal).
// - Só recentes (padrão: até 15 min); mais antigas a loja vê no celular.
// - Se a loja já respondeu aquele cliente pelo celular depois da mensagem dele,
//   o robô não responde e fica pausado para aquele cliente (atendimento humano).

export type OfflineSelection = {
  customerMessages: any[];
  /** Conversas em que a loja respondeu manualmente durante a queda. */
  storeTakeovers: string[];
};

export type OfflineSelectionOptions = {
  now?: number;
  maxAgeMs?: number;
  /** Mensagens enviadas pelo próprio sistema (não contam como resposta manual). */
  isOwnSend?: (messageId: string) => boolean;
};

export function offlineReplyMaxAgeMs() {
  const minutes = Number(process.env.WHATSAPP_OFFLINE_REPLY_MAX_AGE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
}

function timestampMs(msg: any) {
  const raw = msg?.messageTimestamp;
  const seconds = typeof raw === "object" && raw !== null && typeof raw.toNumber === "function" ? raw.toNumber() : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : NaN;
}

function isDirectChat(jid: unknown) {
  const value = String(jid || "");
  return Boolean(value) && value !== "status@broadcast" && !value.endsWith("@g.us") && !value.endsWith("@newsletter")
    && !value.endsWith("@broadcast");
}

function chatKeys(msg: any) {
  return [msg?.key?.remoteJid, msg?.key?.remoteJidAlt]
    .filter((jid): jid is string => typeof jid === "string" && Boolean(jid))
    .map((jid) => jid.split("@")[0].split(":")[0]);
}

export function selectOfflineCustomerMessages(messages: any[], options: OfflineSelectionOptions = {}): OfflineSelection {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? offlineReplyMaxAgeMs();
  const isOwnSend = options.isOwnSend || (() => false);

  // Última resposta manual da loja por conversa (enviada pelo celular durante a queda).
  const lastStoreReply = new Map<string, number>();
  for (const msg of messages || []) {
    if (!msg?.message || !msg?.key?.fromMe || !isDirectChat(msg.key.remoteJid)) continue;
    const id = String(msg.key.id || "");
    if (id && isOwnSend(id)) continue;
    const at = timestampMs(msg);
    // Eco imediato de envio do próprio sistema chega com horário "agora": não é acúmulo.
    if (!Number.isFinite(at) || at > now - 10_000) continue;
    for (const key of chatKeys(msg)) lastStoreReply.set(key, Math.max(lastStoreReply.get(key) || 0, at));
  }

  const takeovers = new Set<string>();
  const customerMessages: any[] = [];
  for (const msg of messages || []) {
    if (!msg?.message || msg?.key?.fromMe || !isDirectChat(msg.key.remoteJid)) continue;
    const at = timestampMs(msg);
    if (!Number.isFinite(at) || now - at > maxAgeMs || at > now + 60_000) continue;
    const answeredByStore = chatKeys(msg).some((key) => (lastStoreReply.get(key) || 0) >= at);
    if (answeredByStore) {
      takeovers.add(String(msg.key.remoteJid));
      continue;
    }
    customerMessages.push(msg);
  }
  customerMessages.sort((a, b) => timestampMs(a) - timestampMs(b));
  return { customerMessages, storeTakeovers: [...takeovers] };
}
