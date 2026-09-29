import { handleAiAssistantMessage as handleLegacyAiAssistantMessage } from "./aiAssistant.js";

type Logger = {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
};

type StoreInfo = {
  storeName?: string;
  menuUrl?: string;
  autoReplyMessage?: string;
  openingHours?: Record<string, unknown> | null;
  timezone?: string;
  isOpen?: boolean | null;
};

type AiAssistantParams = {
  sessionId: string;
  customerJid: string;
  customerPhone?: string | null;
  text: string;
  getStoreInfo: () => Promise<StoreInfo>;
  sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
  logger: Logger;
};

type OrderSummary = {
  id: string;
  orderNumber: string;
  status?: string;
  statusLabel?: string;
  total?: number;
  totalLabel?: string;
};

type PlanOperation = {
  action: "add_item" | "remove_item";
  product: string;
  quantity: number;
  productId?: string | null;
  unitPrice?: number;
  amount?: number;
};

type ChangePlan = { operations: PlanOperation[] };

type ChangeInterpretation = {
  isOrderChange: boolean;
  action: "none" | "propose" | "ask_status" | "discard_draft";
  plan: ChangePlan;
  reply: string;
};

type ChangePreview = {
  changeType?: string;
  operations?: PlanOperation[];
  currentTotal?: number;
  proposedTotal?: number;
  totalDelta?: number;
  canonicalChangePlan?: ChangePlan;
  message?: string;
};

type PendingChangeConversation =
  | { kind: "select_order"; orders: OrderSummary[]; plan: ChangePlan; originalText: string; expiresAt: number }
  | { kind: "clarify"; order: OrderSummary; plan: ChangePlan | null; backendError?: string; expiresAt: number }
  | { kind: "confirm"; order: OrderSummary; plan: ChangePlan; preview: ChangePreview; originalText: string; expiresAt: number };

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim();
const GEMINI_FALLBACK_MODEL = String(process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite").trim();
const VERCEL_API_URL = String(process.env.VERCEL_API_URL || "").trim().replace(/\/$/, "");
const API_KEY = String(process.env.API_KEY || "").trim();
const API_KEY_2 = String(process.env.API_KEY_2 || "").trim();
const REQUEST_TIMEOUT_MS = Math.max(3500, Number(process.env.GEMINI_TIMEOUT_MS || 6500));
const CONVERSATION_TTL_MS = 10 * 60 * 1000;
const MAX_CUSTOMER_TEXT = 2000;
const MAX_OPERATIONS = 8;
const inFlight = new Set<string>();
const pendingChanges = new Map<string, PendingChangeConversation>();

function clean(value: unknown) {
  return String(value || "").trim();
}

function normalizeForMatch(value: unknown) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isAffirmative(value: string) {
  const normalized = normalizeForMatch(value).replace(/[.!?]+$/g, "");
  return ["sim", "s", "confirmo", "confirmar", "pode", "pode sim", "isso", "isso mesmo", "ok", "okay"].includes(normalized);
}

function isNegative(value: string) {
  const normalized = normalizeForMatch(value).replace(/[.!?]+$/g, "");
  return ["nao", "n", "desisto", "deixa", "deixa pra la", "deixa para la", "cancela a alteracao"].includes(normalized);
}

function money(value: unknown) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function orderListText(orders: OrderSummary[]) {
  return orders.map((order, index) => `${index + 1}. Pedido #${order.orderNumber}${order.statusLabel ? ` — ${order.statusLabel}` : ""}${order.totalLabel ? ` — ${order.totalLabel}` : ""}`).join("\n");
}

function chooseOrder(text: string, orders: OrderSummary[]) {
  const normalized = normalizeForMatch(text).replace(/^#/, "");
  const index = Number.parseInt(normalized, 10);
  if (Number.isInteger(index) && index >= 1 && index <= orders.length && String(index) === normalized) return orders[index - 1];
  const token = normalized.replace(/[^a-z0-9-]/g, "");
  return orders.find((order) => normalizeForMatch(order.orderNumber).replace(/^#/, "") === token) || null;
}

function normalizePlan(value: unknown): ChangePlan {
  const rawOperations = Array.isArray((value as any)?.operations) ? (value as any).operations : [];
  const operations: PlanOperation[] = [];
  for (const raw of rawOperations.slice(0, MAX_OPERATIONS)) {
    const action = clean(raw?.action).toLowerCase();
    const product = clean(raw?.product || raw?.productName || raw?.itemName).slice(0, 140);
    const quantity = Number(raw?.quantity);
    if ((action !== "add_item" && action !== "remove_item") || product.length < 2 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) continue;
    operations.push({ action, product, quantity } as PlanOperation);
  }
  return { operations };
}

function parseInterpretation(raw: unknown): ChangeInterpretation | null {
  let text = clean(raw);
  if (!text) return null;
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const value = JSON.parse(text);
    const action = ["none", "propose", "ask_status", "discard_draft"].includes(value?.action) ? value.action : "none";
    return {
      isOrderChange: value?.isOrderChange === true,
      action,
      plan: normalizePlan(value?.plan),
      reply: clean(value?.reply).slice(0, 700),
    };
  } catch {
    return null;
  }
}

function systemInstruction(storeInfo: StoreInfo, draft: PendingChangeConversation | null) {
  const storeName = clean(storeInfo.storeName) || "a loja";
  const draftContext = draft
    ? JSON.stringify({
        kind: draft.kind,
        order: "order" in draft ? { id: draft.order.id, orderNumber: draft.order.orderNumber } : undefined,
        currentPlan: "plan" in draft ? draft.plan : undefined,
        preview: draft.kind === "confirm" ? {
          operations: draft.preview.operations,
          currentTotal: draft.preview.currentTotal,
          proposedTotal: draft.preview.proposedTotal,
        } : undefined,
        backendError: draft.kind === "clarify" ? draft.backendError : undefined,
      })
    : "nenhum";

  return [
    `Você é o interpretador conversacional de alterações de pedidos da loja ${storeName}.`,
    "Sua função aqui NÃO é executar alterações, calcular preços nem inventar produtos. Sua função é entender linguagem humana e devolver a intenção de alteração de itens de forma estruturada.",
    "O backend seguro validará pedido, produto, quantidade, disponibilidade, preço e total. Nunca invente preço, productId, disponibilidade ou resultado de execução.",
    "Retorne APENAS JSON válido com exatamente estas chaves: isOrderChange, action, plan, reply.",
    "isOrderChange deve ser true somente quando a mensagem trata de adicionar/remover/trocar itens de um pedido existente ou de um rascunho de alteração já em andamento.",
    "Cancelamento do pedido inteiro, troca de pagamento, acompanhamento do pedido, cardápio e dúvidas gerais NÃO são item-change: use isOrderChange=false.",
    "action deve ser: propose, ask_status, discard_draft ou none.",
    "Use propose quando o cliente propõe ou revisa itens. plan.operations deve conter o PLANO COMPLETO desejado depois da mensagem atual, não apenas a diferença em relação ao rascunho.",
    "Cada operação deve ter somente action ('add_item' ou 'remove_item'), product (nome/referência dita pelo cliente) e quantity (inteiro de 1 a 99).",
    "Uma troca deve virar duas operações quando apropriado. Exemplo: 'tira o hambúrguer e coloca uma coca 2l no lugar' = remove_item Hambúrguer 1 + add_item Coca Cola 2L 1.",
    "Se já existe rascunho e o cliente disser 'coloca 2 cocas', atualize a quantidade da Coca no plano completo e preserve as demais operações que ele não desfez.",
    "Se já existe rascunho e disser 'deixa o hambúrguer também', remova do plano a operação que retiraria o hambúrguer, preservando as demais operações.",
    "Se disser 'e adiciona também 2 águas', acrescente essa operação ao plano completo.",
    "Se disser 'achei caro, deixa como estava', 'desisti dessa alteração' ou equivalente, use discard_draft e plano vazio.",
    "Se perguntar 'conseguiu tirar?', 'já alterou?', 'foi feito?' sobre o rascunho, use ask_status. Não afirme que foi executado.",
    "Quando a pessoa quer alterar mas ainda não disse o quê, use isOrderChange=true, action=none e plan vazio.",
    "Não transforme pergunta sobre disponibilidade/cardápio em alteração sem evidência de que a pessoa quer mexer em um pedido existente.",
    "reply pode ficar vazio para propose/ask_status/discard_draft. Para esclarecimento sem plano concreto, reply pode ser uma pergunta curta e natural.",
    `Rascunho/contexto seguro atual: ${draftContext}`,
  ].join("\n");
}

async function requestInterpretation(params: AiAssistantParams, storeInfo: StoreInfo, draft: PendingChangeConversation | null) {
  if (!GEMINI_API_KEY || !GEMINI_MODEL) return null;
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemInstruction(storeInfo, draft) }] },
    contents: [{ role: "user", parts: [{ text: clean(params.text).slice(0, MAX_CUSTOMER_TEXT) }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: "minimal" },
      maxOutputTokens: 700,
      responseMimeType: "application/json",
    },
  });

  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL || GEMINI_MODEL];
  for (let attempt = 0; attempt < models.length; attempt += 1) {
    const model = models[attempt];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const parts = data?.candidates?.[0]?.content?.parts;
        const raw = Array.isArray(parts) ? parts.map((part: any) => clean(part?.text)).filter(Boolean).join("\n") : "";
        const parsed = parseInterpretation(raw);
        params.logger.info({ sessionId: params.sessionId, model, attempt: attempt + 1, parsed: Boolean(parsed) }, "[AI-Assistant-V2] Gemini interpretation completed");
        if (parsed) return parsed;
      } else {
        params.logger.warn({ sessionId: params.sessionId, model, status: response.status, attempt: attempt + 1 }, "[AI-Assistant-V2] Gemini interpretation request failed");
      }
    } catch (error: any) {
      params.logger.warn({ sessionId: params.sessionId, model, attempt: attempt + 1, error: error?.message || error }, "[AI-Assistant-V2] Gemini interpretation error");
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function postBackend(path: string, body: Record<string, unknown>, params: AiAssistantParams) {
  const baseUrls = [VERCEL_API_URL, "https://www.clickaipedidos.com.br"]
    .map((value) => value.replace(/\/$/, ""))
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
  const keys = [API_KEY, API_KEY_2].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
  let last = { ok: false, status: 503, data: { error: "O atendimento automático está temporariamente indisponível." } } as any;

  for (const baseUrl of baseUrls) {
    for (const key of keys) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": key },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        last = { ok: response.ok, status: response.status, data };
        if (response.ok) return last;
        if (response.status !== 401 && response.status < 500) return last;
      } catch (error: any) {
        params.logger.warn({ sessionId: params.sessionId, path, error: error?.message || error }, "[AI-Assistant-V2] Click Ai backend request failed");
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return last;
}

async function sendText(params: AiAssistantParams, text: string) {
  await params.sendMessage(params.customerJid, { text });
}

function backendMessage(result: any, fallback: string) {
  return clean(result?.data?.message || result?.data?.error) || fallback;
}

async function lookupOrders(params: AiAssistantParams) {
  return postBackend("/api/webhook/whatsapp/order-self-service", {
    action: "lookup",
    intent: "change",
    sessionId: params.sessionId,
    phone: clean(params.customerPhone),
  }, params);
}

function buildPreviewText(order: OrderSummary, preview: ChangePreview) {
  const operations = Array.isArray(preview.operations) ? preview.operations : [];
  const lines = operations.map((operation) => {
    const quantity = Number(operation.quantity) || 1;
    const unitPrice = Number(operation.unitPrice) || 0;
    const amount = Number(operation.amount) || 0;
    if (operation.action === "add_item") {
      return `• Adicionar *${quantity}x ${clean(operation.product)}* — ${money(unitPrice)} cada = *+${money(amount)}*`;
    }
    return `• Remover *${quantity}x ${clean(operation.product)}* — *-${money(amount)}*`;
  });
  return [
    `📋 *Confira a alteração do pedido #${order.orderNumber}*`,
    "",
    ...lines,
    "",
    `Total atual: *${money(preview.currentTotal)}*`,
    `Novo total: *${money(preview.proposedTotal)}*`,
    "",
    "*É isso mesmo que você quer?* Responda *SIM* para enviar à loja.",
    "Se quiser mudar quantidade, manter algum item, acrescentar outro produto ou desistir, pode falar normalmente antes de confirmar.",
    "A loja ainda não recebeu esta solicitação.",
  ].join("\n");
}

async function preparePreview(params: AiAssistantParams, key: string, order: OrderSummary, plan: ChangePlan, originalText: string) {
  const result = await postBackend("/api/webhook/whatsapp/order-self-service", {
    action: "change",
    previewOnly: true,
    sessionId: params.sessionId,
    phone: clean(params.customerPhone),
    orderId: order.id,
    changeText: clean(originalText).slice(0, 600) || "Alteração de itens solicitada pelo cliente",
    changePlan: plan,
  }, params);

  if (!result.ok) {
    const error = backendMessage(result, "Não consegui validar essa alteração no pedido atual.");
    pendingChanges.set(key, { kind: "clarify", order, plan, backendError: error, expiresAt: Date.now() + CONVERSATION_TTL_MS });
    await sendText(params, `${error}\n\nPode me explicar como você quer deixar o pedido?`);
    return false;
  }

  const preview = (result.data || {}) as ChangePreview;
  const canonical = normalizePlan(preview.canonicalChangePlan || plan);
  pendingChanges.set(key, {
    kind: "confirm",
    order,
    plan: canonical,
    preview,
    originalText,
    expiresAt: Date.now() + CONVERSATION_TTL_MS,
  });
  await sendText(params, buildPreviewText(order, preview));
  params.logger.info({ sessionId: params.sessionId, remoteJid: params.customerJid, orderId: order.id, operationCount: canonical.operations.length }, "[AI-Assistant-V2] Structured change preview prepared");
  return true;
}

async function commitPlan(params: AiAssistantParams, state: Extract<PendingChangeConversation, { kind: "confirm" }>) {
  const result = await postBackend("/api/webhook/whatsapp/order-self-service", {
    action: "change",
    sessionId: params.sessionId,
    phone: clean(params.customerPhone),
    orderId: state.order.id,
    changeText: clean(state.originalText).slice(0, 600) || "Alteração de itens confirmada pelo cliente",
    changePlan: state.plan,
  }, params);
  await sendText(params, backendMessage(result, "Não consegui enviar essa alteração para a loja agora. Tente novamente."));
}

async function startWithPlan(params: AiAssistantParams, key: string, plan: ChangePlan, originalText: string) {
  if (!clean(params.customerPhone)) {
    await sendText(params, "Não consegui identificar o telefone deste contato para localizar o pedido. Fale com a loja para continuar.");
    return true;
  }
  const lookup = await lookupOrders(params);
  if (!lookup.ok) {
    await sendText(params, backendMessage(lookup, "Não encontrei um pedido que ainda possa ser alterado por aqui."));
    return true;
  }
  const orders = Array.isArray(lookup?.data?.orders) ? lookup.data.orders as OrderSummary[] : [];
  if (!orders.length) {
    await sendText(params, "Não encontrei um pedido que ainda possa ser alterado por aqui.");
    return true;
  }
  if (orders.length === 1) {
    if (!plan.operations.length) {
      pendingChanges.set(key, { kind: "clarify", order: orders[0], plan: null, expiresAt: Date.now() + CONVERSATION_TTL_MS });
      await sendText(params, `Claro. O que você quer mudar no pedido #${orders[0].orderNumber}? Pode falar normalmente, por exemplo tirar um item, trocar por outro ou mudar a quantidade.`);
      return true;
    }
    await preparePreview(params, key, orders[0], plan, originalText);
    return true;
  }
  pendingChanges.set(key, { kind: "select_order", orders, plan, originalText, expiresAt: Date.now() + CONVERSATION_TTL_MS });
  await sendText(params, `Encontrei mais de um pedido recente. Qual deles você quer alterar? Responda com o número da lista ou do pedido:\n\n${orderListText(orders)}`);
  return true;
}

async function handlePending(params: AiAssistantParams, key: string, state: PendingChangeConversation, storeInfo: StoreInfo) {
  const text = clean(params.text);
  if (state.kind === "select_order") {
    if (isNegative(text)) {
      pendingChanges.delete(key);
      await sendText(params, "Tudo bem. Nenhuma alteração foi enviada.");
      return true;
    }
    const order = chooseOrder(text, state.orders);
    if (!order) {
      await sendText(params, `Não consegui identificar qual pedido você escolheu. Responda com o número da lista ou do pedido:\n\n${orderListText(state.orders)}`);
      return true;
    }
    pendingChanges.delete(key);
    if (!state.plan.operations.length) {
      pendingChanges.set(key, { kind: "clarify", order, plan: null, expiresAt: Date.now() + CONVERSATION_TTL_MS });
      await sendText(params, `Certo. O que você quer mudar no pedido #${order.orderNumber}?`);
      return true;
    }
    await preparePreview(params, key, order, state.plan, state.originalText);
    return true;
  }

  if (state.kind === "confirm") {
    if (isAffirmative(text)) {
      pendingChanges.delete(key);
      await commitPlan(params, state);
      return true;
    }
    if (isNegative(text)) {
      pendingChanges.delete(key);
      await sendText(params, "Tudo bem. Descartei essa alteração e o pedido continua como estava.");
      return true;
    }
  }

  const interpretation = await requestInterpretation(params, storeInfo, state);
  if (!interpretation) {
    await sendText(params, "Não consegui entender essa resposta agora. A alteração anterior continua sem ser enviada. Você pode explicar novamente ou responder *SIM*/*NÃO*.");
    return true;
  }

  if (interpretation.action === "discard_draft") {
    pendingChanges.delete(key);
    await sendText(params, "Tudo bem. Descartei essa alteração e o pedido continua como estava.");
    return true;
  }

  if (interpretation.action === "ask_status") {
    if (state.kind === "confirm") {
      await sendText(params, "Ainda não. Essa alteração ainda não foi enviada à loja porque estou aguardando a sua confirmação. Se estiver tudo certo, responda *SIM*.");
    } else {
      await sendText(params, "Ainda não existe uma alteração confirmada para enviar. Me diga como você quer deixar o pedido e eu confiro tudo antes.");
    }
    return true;
  }

  if (interpretation.action === "propose" && interpretation.plan.operations.length) {
    const order = state.order;
    await preparePreview(params, key, order, interpretation.plan, text);
    return true;
  }

  if (interpretation.reply) {
    await sendText(params, interpretation.reply);
    return true;
  }

  await sendText(params, `Me diga como você quer deixar o pedido #${state.order.orderNumber}. Eu vou conferir os itens e valores antes de enviar qualquer alteração à loja.`);
  return true;
}

export async function handleAiAssistantMessage(params: AiAssistantParams): Promise<boolean> {
  if (!GEMINI_API_KEY) return handleLegacyAiAssistantMessage(params);
  const text = clean(params.text);
  if (!text || !params.customerJid) return false;

  const key = `${params.sessionId}:${params.customerJid}`;
  const active = pendingChanges.get(key) || null;
  if (active && active.expiresAt <= Date.now()) pendingChanges.delete(key);
  const current = pendingChanges.get(key) || null;

  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    const storeInfo = await params.getStoreInfo();
    if (current) {
      return await handlePending(params, key, current, storeInfo || {});
    }

    const interpretation = await requestInterpretation(params, storeInfo || {}, null);
    if (!interpretation || !interpretation.isOrderChange) {
      return await handleLegacyAiAssistantMessage(params);
    }

    if (interpretation.action === "discard_draft" || interpretation.action === "ask_status") {
      await sendText(params, "Não há uma alteração de itens aguardando sua confirmação neste momento. Se quiser mudar o pedido, me diga o que deseja adicionar, remover ou trocar.");
      return true;
    }

    if (interpretation.action === "propose") {
      return await startWithPlan(params, key, interpretation.plan, text);
    }

    return await startWithPlan(params, key, { operations: [] }, text);
  } catch (error: any) {
    params.logger.warn({ error: error?.message || error, sessionId: params.sessionId, remoteJid: params.customerJid }, "[AI-Assistant-V2] Conversational order-change flow failed");
    if (pendingChanges.has(key)) {
      await sendText(params, "Não consegui continuar essa alteração agora. Nada foi enviado à loja; tente novamente em instantes.").catch(() => undefined);
      return true;
    }
    return await handleLegacyAiAssistantMessage(params).catch(() => false);
  } finally {
    inFlight.delete(key);
  }
}
