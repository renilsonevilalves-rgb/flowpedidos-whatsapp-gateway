// Vigilância da conexão do WhatsApp de cada loja.
//
// Problema que isto resolve: a conexão pode ficar "zumbi" — aparece como conectada,
// mas o WhatsApp para de entregar mensagens ao sistema. Acontece quando, ao (re)conectar,
// a loja tem mensagens/avisos acumulados: o WhatsApp entrega esse acúmulo em lotes e só
// libera as mensagens novas depois que o último lote termina. A biblioteca pede apenas
// o primeiro lote (100 itens); se a loja tem mais do que isso acumulado (loja movimentada
// ou queda mais longa), o resto nunca chega e o atendimento para sem nenhum erro.
//
// O que fazemos, em ordem:
// 1. Enquanto a sincronização das pendências não termina, pedimos o próximo lote assim
//    que o anterior para de chegar (igual ao WhatsApp Web faz).
// 2. Se mesmo assim a sincronização não terminar no prazo, reconectamos a loja.
// 3. Depois de sincronizada, se chegar mensagem e ela não for processada no prazo
//    (processamento travado), reconectamos também.
// Lojas sem movimento nunca são reconectadas à toa: só agimos com sinal concreto de travamento.

export type StallReason = "offline_sync_stuck" | "inbound_pipeline_stuck";

export type HealthConfig = {
  /** Intervalo entre verificações. */
  tickMs: number;
  /** Sem novos itens pendentes por este tempo: o lote acabou, pede o próximo. */
  offlineIdleMs: number;
  /** Sem aviso de pendências e sem conclusão: começa a pedir lotes depois deste tempo. */
  offlineNudgeAfterMs: number;
  /** Tamanho do lote pedido (o mesmo que a biblioteca usa). */
  offlineBatchSize: number;
  /** Limite de pedidos de lote por conexão. */
  maxOfflineBatchRequests: number;
  /** Prazo máximo para a sincronização das pendências terminar. */
  offlineSyncDeadlineMs: number;
  /** Prazo máximo para uma mensagem recebida ser processada. */
  inboundStallMs: number;
};

const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function defaultHealthConfig(): HealthConfig {
  return {
    tickMs: 5_000,
    offlineIdleMs: envNumber("WHATSAPP_HEALTH_OFFLINE_IDLE_MS", 4_000),
    offlineNudgeAfterMs: envNumber("WHATSAPP_HEALTH_OFFLINE_NUDGE_MS", 20_000),
    offlineBatchSize: 100,
    maxOfflineBatchRequests: 300,
    offlineSyncDeadlineMs: envNumber("WHATSAPP_HEALTH_OFFLINE_DEADLINE_MS", 180_000),
    inboundStallMs: envNumber("WHATSAPP_HEALTH_INBOUND_STALL_MS", 120_000),
  };
}

type Logger = {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
};

export type HealthOptions = {
  sessionId: string;
  sock: any;
  logger: Logger;
  onStall: (reason: StallReason, details: Record<string, unknown>) => void;
  /** Para de vigiar quando este socket deixa de ser o atual da loja. */
  isCurrent?: () => boolean;
  config?: Partial<HealthConfig>;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: any) => void;
};

const MAX_TRACKED_INBOUND = 500;

function isIgnoredInbound(node: any) {
  const from = String(node?.attrs?.from || "");
  if (!from || from === "status@broadcast" || from.endsWith("@newsletter")) return true;
  const content = Array.isArray(node?.content) ? node.content : [];
  // A biblioteca descarta este tipo sem gerar evento de mensagem.
  return content.some((child: any) => child?.tag === "enc" && child?.attrs?.type === "msmsg");
}

/** Liga a vigilância para um socket. Retorna a função que desliga. */
export function watchConnectionHealth(options: HealthOptions): () => void {
  if (process.env.WHATSAPP_HEALTH_WATCHDOG === "false") return () => undefined;
  const { sessionId, sock, logger } = options;
  const ev = sock?.ev;
  const ws = sock?.ws;
  if (!ev || typeof ev.on !== "function") return () => undefined;

  const config = { ...defaultHealthConfig(), ...(options.config || {}) };
  const now = options.now || Date.now;
  const startTimer = options.setInterval || ((callback: () => void, ms: number) => setInterval(callback, ms));
  const stopTimer = options.clearInterval || ((handle: any) => clearInterval(handle));

  let stopped = false;
  let openedAt: number | undefined;
  let offlineDone = false;
  let previewAt: number | undefined;
  let lastOfflineNodeAt: number | undefined;
  let lastBatchRequestAt: number | undefined;
  let batchRequests = 0;
  let offlineNodes = 0;
  // Mensagens recebidas (fora do acúmulo) aguardando processamento: id → horário.
  const pendingInbound = new Map<string, number>();

  const sendNextBatch = () => {
    if (typeof sock.sendNode !== "function") return;
    batchRequests += 1;
    lastBatchRequestAt = now();
    if (batchRequests === 1 || batchRequests % 10 === 0) {
      logger.warn({ sessionId, batchRequests, offlineNodes }, "[Health] Sincronização de pendências parada; pedindo o próximo lote ao WhatsApp");
    }
    Promise.resolve()
      .then(() => sock.sendNode({ tag: "ib", attrs: {}, content: [{ tag: "offline_batch", attrs: { count: String(config.offlineBatchSize) } }] }))
      .catch(() => undefined);
  };

  const onPreview = () => { previewAt = now(); };
  const onOfflineDone = () => {
    if (offlineDone) return;
    offlineDone = true;
    if (batchRequests > 0) {
      logger.info({ sessionId, batchRequests, offlineNodes }, "[Health] Pendências sincronizadas; conexão recebendo normalmente");
    }
  };
  const onInboundNode = (node: any) => {
    if (node?.attrs?.offline) {
      offlineNodes += 1;
      lastOfflineNodeAt = now();
      return;
    }
    if (node?.tag !== "message" || isIgnoredInbound(node)) return;
    const id = String(node?.attrs?.id || "");
    if (!id) return;
    if (pendingInbound.size >= MAX_TRACKED_INBOUND) {
      const oldest = pendingInbound.keys().next().value;
      if (oldest !== undefined) pendingInbound.delete(oldest);
    }
    if (!pendingInbound.has(id)) pendingInbound.set(id, now());
  };
  const onUpsert = (event: any) => {
    // Mensagem em tempo real processada = conexão comprovadamente viva.
    if (event?.type === "notify") onOfflineDone();
    // O processamento é em ordem: se uma mensagem saiu, as que chegaram antes dela
    // também já passaram (ou foram descartadas de propósito pela biblioteca).
    let processedArrival = -Infinity;
    for (const msg of event?.messages || []) {
      const at = pendingInbound.get(String(msg?.key?.id || ""));
      if (at !== undefined && at > processedArrival) processedArrival = at;
    }
    if (processedArrival === -Infinity) return;
    for (const [id, at] of pendingInbound) if (at <= processedArrival) pendingInbound.delete(id);
  };
  const onConnection = (update: any) => {
    if (update?.connection === "open") openedAt = now();
    if (update?.receivedPendingNotifications === true) onOfflineDone();
    if (update?.connection === "close") stop();
  };

  const wsEvents: Array<[string, (node: any) => void]> = [
    ["CB:ib,,offline_preview", onPreview],
    ["CB:ib,,offline", onOfflineDone],
    ["CB:message", onInboundNode],
    ["CB:receipt", onInboundNode],
    ["CB:notification", onInboundNode],
    ["CB:call", onInboundNode],
  ];

  const stall = (reason: StallReason, details: Record<string, unknown>) => {
    stop();
    options.onStall(reason, { batchRequests, offlineNodes, ...details });
  };

  const tick = () => {
    if (stopped) return;
    if (options.isCurrent && !options.isCurrent()) { stop(); return; }
    if (openedAt === undefined) return;
    const current = now();

    if (!offlineDone) {
      const sinceOpen = current - openedAt;
      if (sinceOpen >= config.offlineSyncDeadlineMs) {
        stall("offline_sync_stuck", { sinceOpenMs: sinceOpen });
        return;
      }
      const lastActivity = Math.max(openedAt, previewAt ?? 0, lastOfflineNodeAt ?? 0, lastBatchRequestAt ?? 0);
      const shouldNudge = (previewAt !== undefined || sinceOpen >= config.offlineNudgeAfterMs)
        && current - lastActivity >= config.offlineIdleMs
        && batchRequests < config.maxOfflineBatchRequests;
      if (shouldNudge) sendNextBatch();
      return;
    }

    const oldest = pendingInbound.values().next().value;
    if (oldest !== undefined && current - oldest >= config.inboundStallMs) {
      stall("inbound_pipeline_stuck", { pendingMessages: pendingInbound.size, oldestPendingMs: current - oldest });
    }
  };

  const handle = startTimer(tick, config.tickMs);

  function stop() {
    if (stopped) return;
    stopped = true;
    stopTimer(handle);
    if (typeof ev.off === "function") {
      ev.off("connection.update", onConnection);
      ev.off("messages.upsert", onUpsert);
    }
    if (ws && typeof ws.off === "function") for (const [name, listener] of wsEvents) ws.off(name, listener);
    pendingInbound.clear();
  }

  ev.on("connection.update", onConnection);
  ev.on("messages.upsert", onUpsert);
  if (ws && typeof ws.on === "function") for (const [name, listener] of wsEvents) ws.on(name, listener);
  return stop;
}

/**
 * Espera antes de reconectar uma loja que travou de novo. As duas primeiras vezes
 * (em 30 min) são imediatas; depois cresce até 5 min para não martelar o WhatsApp.
 */
export function stallRecoveryDelayMs(recentStalls: number): number {
  if (recentStalls <= 2) return 0;
  return Math.min(5 * 60_000, 30_000 * 2 ** (recentStalls - 3));
}
