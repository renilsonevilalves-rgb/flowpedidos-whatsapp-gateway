type Logger = {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
};

type SendMessage = (jid: string, content: { text: string }) => Promise<unknown>;

type OrderSummary = {
  id: string;
  orderNumber: string;
  status: string;
  statusLabel: string;
  total: number;
  totalLabel: string;
  createdAt: string;
};

type ConversationState =
  | { kind: "cancel_select"; orders: OrderSummary[]; expiresAt: number }
  | { kind: "cancel_confirm"; order: OrderSummary; expiresAt: number }
  | { kind: "change_select"; orders: OrderSummary[]; expiresAt: number }
  | { kind: "change_text"; order: OrderSummary; expiresAt: number };

type HandleParams = {
  sessionId: string;
  msg: any;
  remoteJid: string;
  text: string;
  vercelApiUrl: string;
  apiKey: string;
  apiKey2?: string;
  sendMessage: SendMessage;
  logger: Logger;
};

const STATE_TTL_MS = 10 * 60 * 1000;
const conversations = new Map<string, ConversationState>();

class OrderSelfServiceApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "OrderSelfServiceApiError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeOrderSelfServiceText(value: string) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCancelOrderTrigger(value: string) {
  const text = normalizeOrderSelfServiceText(value).replace(/[!,.?]+$/g, "").trim();
  if (/^(cancelar|cancelamento|cancelar(?:\s+(?:(?:meu|o)\s+)?pedido)?)$/.test(text)) return true;
  return /^(?:quero|queria|preciso|desejo|gostaria de)\s+(?:fazer\s+(?:um\s+)?)?(?:cancelamento(?:\s+do\s+(?:meu\s+)?pedido)?|cancelar(?:\s+(?:(?:meu|o)\s+)?pedido)?)$/.test(text);
}

export function isChangeOrderTrigger(value: string) {
  const text = normalizeOrderSelfServiceText(value).replace(/[!,.?]+$/g, "").trim();
  if (/^(alterar|alteracao|mudar|editar|alterar(?:\s+(?:(?:meu|o)\s+)?pedido)|mudar(?:\s+(?:(?:meu|o)\s+)?pedido)|editar(?:\s+(?:(?:meu|o)\s+)?pedido))$/.test(text)) return true;
  return /^(?:quero|queria|preciso|desejo|gostaria de)\s+(?:fazer\s+(?:uma\s+)?)?(?:alteracao(?:\s+(?:no|do)\s+(?:meu\s+)?pedido)?|alterar(?:\s+(?:(?:meu|o)\s+)?pedido)?|mudar(?:\s+(?:(?:meu|o)\s+)?pedido)?|editar(?:\s+(?:(?:meu|o)\s+)?pedido)?)$/.test(text);
}

function getCustomerJid(msg: any, remoteJid: string) {
  return [
    msg?.key?.remoteJidAlt,
    msg?.key?.senderPn,
    msg?.key?.participantPn,
    remoteJid,
  ].find((value: unknown) => typeof value === "string" && /@s\.whatsapp\.net$/.test(value)) ||
    msg?.key?.remoteJidAlt ||
    msg?.key?.senderPn ||
    msg?.key?.participantPn ||
    remoteJid;
}

function getPhoneFromJid(jid: string) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function stateKey(sessionId: string, customerJid: string) {
  return `${sessionId}:${customerJid}`;
}

function setState(key: string, state: Omit<ConversationState, "expiresAt">) {
  conversations.set(key, { ...state, expiresAt: Date.now() + STATE_TTL_MS } as ConversationState);
}

function getState(key: string) {
  const state = conversations.get(key);
  if (!state) return undefined;
  if (state.expiresAt <= Date.now()) {
    conversations.delete(key);
    return undefined;
  }
  return state;
}

function clearState(key: string) {
  conversations.delete(key);
}

function isAbortText(value: string) {
  const text = normalizeOrderSelfServiceText(value);
  return /^(nao|2|sair|desistir|deixa pra la|deixar pra la|manter pedido)$/.test(text);
}

function isCancelConfirmation(value: string) {
  const text = normalizeOrderSelfServiceText(value);
  return /^(sim cancelar|confirmar cancelamento|confirmo o cancelamento|confirmo|sim|1)$/.test(text);
}

function normalizeOrderNumber(value: string) {
  return normalizeOrderSelfServiceText(value)
    .replace(/^pedido\s*/, "")
    .replace(/^#/, "")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function findSelectedOrder(orders: OrderSummary[], text: string) {
  const requested = normalizeOrderNumber(text);
  if (!requested) return undefined;
  return orders.find((order) => normalizeOrderNumber(order.orderNumber) === requested);
}

function baseUrls(vercelApiUrl: string) {
  return [
    vercelApiUrl,
    "https://www.clickaipedidos.com.br",
    "https://flowoficial01.vercel.app",
  ]
    .map((value) => String(value || "").replace(/\/$/, ""))
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
}

async function callOrderSelfServiceApi(
  params: Pick<HandleParams, "sessionId" | "vercelApiUrl" | "apiKey" | "apiKey2" | "logger">,
  body: Record<string, unknown>,
) {
  const keys = [params.apiKey, params.apiKey2]
    .map((value) => String(value || "").trim())
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);

  if (!keys.length) throw new Error("No gateway API key is configured");

  let lastError: Error | undefined;

  for (const baseUrl of baseUrls(params.vercelApiUrl)) {
    for (const key of keys) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${baseUrl}/api/webhook/whatsapp/order-self-service`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": key },
          body: JSON.stringify({ sessionId: params.sessionId, ...body }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));

        if (response.ok) return data;

        const apiError = new OrderSelfServiceApiError(
          String(data?.error || `Order self-service returned HTTP ${response.status}`),
          response.status,
          data?.code ? String(data.code) : undefined,
        );
        lastError = apiError;

        params.logger.warn(
          {
            sessionId: params.sessionId,
            status: response.status,
            code: apiError.code,
            baseUrl,
            keySlot: key === params.apiKey ? "API_KEY" : "API_KEY_2",
          },
          "[Order-Self-Service] API request failed",
        );

        if (response.status === 404 || response.status === 409 || (response.status >= 400 && response.status < 500 && response.status !== 401)) {
          throw apiError;
        }
      } catch (error: any) {
        if (error instanceof OrderSelfServiceApiError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  throw lastError || new Error("Order self-service request failed");
}

function formatOrderChoices(orders: OrderSummary[]) {
  return orders
    .slice(0, 5)
    .map((order) => `• *#${order.orderNumber}* — ${order.totalLabel} — ${order.statusLabel}`)
    .join("\n");
}

async function beginCancelFlow(params: HandleParams, customerJid: string, phone: string, key: string) {
  clearState(key);
  try {
    const result = await callOrderSelfServiceApi(params, { action: "lookup", intent: "cancel", phone });
    const orders = Array.isArray(result?.orders) ? result.orders as OrderSummary[] : [];
    if (!orders.length) throw new Error("No actionable order returned");

    if (orders.length > 1) {
      setState(key, { kind: "cancel_select", orders });
      await params.sendMessage(customerJid, {
        text: `Encontrei mais de um pedido que ainda pode ser cancelado.\n\n${formatOrderChoices(orders)}\n\nDigite somente o número do pedido que deseja cancelar. Ex.: *${orders[0].orderNumber}*\n\nDigite *SAIR* para encerrar.`,
      });
      return;
    }

    const order = orders[0];
    setState(key, { kind: "cancel_confirm", order });
    await params.sendMessage(customerJid, {
      text: `⚠️ Encontrei o pedido *#${order.orderNumber}* (${order.totalLabel}).\n\nPara evitar cancelamento por engano, responda exatamente *SIM CANCELAR* para confirmar.\n\nPara manter o pedido, responda *NÃO*.`,
    });
  } catch (error: any) {
    clearState(key);
    const message = error instanceof OrderSelfServiceApiError
      ? error.message
      : "Não consegui verificar um pedido disponível para cancelamento agora. Tente novamente em instantes.";
    await params.sendMessage(customerJid, { text: message });
    params.logger.error({ error: error?.message || error, sessionId: params.sessionId }, "[Order-Self-Service] Cancel lookup failed");
  }
}

async function beginChangeFlow(params: HandleParams, customerJid: string, phone: string, key: string) {
  clearState(key);
  try {
    const result = await callOrderSelfServiceApi(params, { action: "lookup", intent: "change", phone });
    const orders = Array.isArray(result?.orders) ? result.orders as OrderSummary[] : [];
    if (!orders.length) throw new Error("No actionable order returned");

    if (orders.length > 1) {
      setState(key, { kind: "change_select", orders });
      await params.sendMessage(customerJid, {
        text: `Encontrei mais de um pedido que ainda pode receber alteração.\n\n${formatOrderChoices(orders)}\n\nDigite somente o número do pedido que deseja alterar. Ex.: *${orders[0].orderNumber}*\n\nDigite *SAIR* para encerrar.`,
      });
      return;
    }

    const order = orders[0];
    setState(key, { kind: "change_text", order });
    await params.sendMessage(customerJid, {
      text: `✏️ Pedido *#${order.orderNumber}*.\n\nEnvie em *uma única mensagem* a alteração desejada.\nEx.: “Retirar 1 Hamburgão” ou “sem cebola no hambúrguer”.\n\nRemoções de itens identificadas com clareza são aplicadas automaticamente e atualizam o total. Outras alterações ficam registradas para confirmação da loja.\n\nDigite *SAIR* para desistir.`,
    });
  } catch (error: any) {
    clearState(key);
    const message = error instanceof OrderSelfServiceApiError
      ? error.message
      : "Não consegui verificar um pedido disponível para alteração agora. Tente novamente em instantes.";
    await params.sendMessage(customerJid, { text: message });
    params.logger.error({ error: error?.message || error, sessionId: params.sessionId }, "[Order-Self-Service] Change lookup failed");
  }
}

async function handleCancelState(
  params: HandleParams,
  customerJid: string,
  phone: string,
  key: string,
  state: Extract<ConversationState, { kind: "cancel_select" | "cancel_confirm" }>,
) {
  if (isAbortText(params.text)) {
    clearState(key);
    await params.sendMessage(customerJid, { text: "Tudo certo. O pedido foi mantido e nenhum cancelamento foi feito. ✅" });
    return true;
  }

  if (state.kind === "cancel_select") {
    const selected = findSelectedOrder(state.orders, params.text);
    if (!selected) {
      await params.sendMessage(customerJid, {
        text: `Não reconheci esse número de pedido. Digite um destes números:\n\n${formatOrderChoices(state.orders)}\n\nOu digite *SAIR*.`,
      });
      return true;
    }
    setState(key, { kind: "cancel_confirm", order: selected });
    await params.sendMessage(customerJid, {
      text: `⚠️ Você escolheu o pedido *#${selected.orderNumber}* (${selected.totalLabel}).\n\nResponda exatamente *SIM CANCELAR* para confirmar ou *NÃO* para manter o pedido.`,
    });
    return true;
  }

  if (!isCancelConfirmation(params.text)) {
    await params.sendMessage(customerJid, {
      text: `Para confirmar o cancelamento do pedido *#${state.order.orderNumber}*, responda *SIM CANCELAR*.\nPara manter o pedido, responda *NÃO*.`,
    });
    return true;
  }

  try {
    const result = await callOrderSelfServiceApi(params, {
      action: "cancel",
      phone,
      orderId: state.order.id,
    });
    clearState(key);
    await params.sendMessage(customerJid, { text: String(result?.message || `✅ Pedido #${state.order.orderNumber} cancelado com sucesso.`) });
    params.logger.info({ sessionId: params.sessionId, orderId: state.order.id }, "[Order-Self-Service] Order cancelled by customer");
  } catch (error: any) {
    clearState(key);
    const message = error instanceof OrderSelfServiceApiError
      ? error.message
      : "Não consegui concluir o cancelamento agora. Consulte o status do pedido e tente novamente.";
    await params.sendMessage(customerJid, { text: message });
    params.logger.error({ error: error?.message || error, sessionId: params.sessionId, orderId: state.order.id }, "[Order-Self-Service] Cancellation failed");
  }
  return true;
}

async function handleChangeState(
  params: HandleParams,
  customerJid: string,
  phone: string,
  key: string,
  state: Extract<ConversationState, { kind: "change_select" | "change_text" }>,
) {
  if (isAbortText(params.text)) {
    clearState(key);
    await params.sendMessage(customerJid, { text: "Tudo certo. Nenhuma alteração foi feita no pedido. ✅" });
    return true;
  }

  if (state.kind === "change_select") {
    const selected = findSelectedOrder(state.orders, params.text);
    if (!selected) {
      await params.sendMessage(customerJid, {
        text: `Não reconheci esse número de pedido. Digite um destes números:\n\n${formatOrderChoices(state.orders)}\n\nOu digite *SAIR*.`,
      });
      return true;
    }
    setState(key, { kind: "change_text", order: selected });
    await params.sendMessage(customerJid, {
      text: `✏️ Pedido *#${selected.orderNumber}*.\n\nEnvie em *uma única mensagem* a alteração desejada. A solicitação será registrada no pedido.\n\nDigite *SAIR* para desistir.`,
    });
    return true;
  }

  if (isCancelOrderTrigger(params.text)) {
    return false;
  }

  const changeText = String(params.text || '').trim();
  if (changeText.length < 3) {
    await params.sendMessage(customerJid, { text: "Descreva a alteração em uma mensagem um pouco mais completa, ou digite *SAIR*." });
    return true;
  }
  if (changeText.length > 600) {
    await params.sendMessage(customerJid, { text: "A alteração ficou muito longa. Envie uma descrição com até 600 caracteres." });
    return true;
  }

  try {
    const result = await callOrderSelfServiceApi(params, {
      action: "change",
      phone,
      orderId: state.order.id,
      changeText,
    });
    clearState(key);
    await params.sendMessage(customerJid, { text: String(result?.message || `✅ Alteração registrada no pedido #${state.order.orderNumber}.`) });
    params.logger.info({ sessionId: params.sessionId, orderId: state.order.id }, "[Order-Self-Service] Order change registered by customer");
  } catch (error: any) {
    clearState(key);
    const message = error instanceof OrderSelfServiceApiError
      ? error.message
      : "Não consegui registrar a alteração agora. Consulte o status do pedido e tente novamente.";
    await params.sendMessage(customerJid, { text: message });
    params.logger.error({ error: error?.message || error, sessionId: params.sessionId, orderId: state.order.id }, "[Order-Self-Service] Change request failed");
  }
  return true;
}

export async function handleOrderSelfServiceMessage(params: HandleParams) {
  const customerJid = getCustomerJid(params.msg, params.remoteJid);
  const phone = getPhoneFromJid(customerJid);
  if (!customerJid || !phone) return false;

  const key = stateKey(params.sessionId, customerJid);
  const state = getState(key);

  if (state?.kind === "cancel_select" || state?.kind === "cancel_confirm") {
    return handleCancelState(params, customerJid, phone, key, state);
  }

  if (state?.kind === "change_select" || state?.kind === "change_text") {
    if (isCancelOrderTrigger(params.text)) {
      clearState(key);
      await beginCancelFlow(params, customerJid, phone, key);
      return true;
    }
    return handleChangeState(params, customerJid, phone, key, state);
  }

  if (isCancelOrderTrigger(params.text)) {
    await beginCancelFlow(params, customerJid, phone, key);
    return true;
  }

  if (isChangeOrderTrigger(params.text)) {
    await beginChangeFlow(params, customerJid, phone, key);
    return true;
  }

  return false;
}
