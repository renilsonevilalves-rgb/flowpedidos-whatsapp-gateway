// Confirmação real de entrega do botão do cardápio.
//
// O WhatsApp pode aceitar o botão (ACK do servidor) e mesmo assim nenhum aparelho
// exibir a mensagem — nem o do cliente, nem o da própria loja. Nesse caso não há
// erro nem recibo. Aqui esperamos o recibo de algum aparelho; sem ele, quem chama
// manda texto + link. Contas onde o botão não chega passam a receber o texto
// direto por um tempo, para o cliente não esperar a cada saudação.

const DEFAULT_TIMEOUT_MS = Number(process.env.WHATSAPP_BUTTON_DELIVERY_TIMEOUT_MS || 8000);
const BLOCK_MS = Number(process.env.WHATSAPP_BUTTON_RETRY_AFTER_MINUTES || 120) * 60 * 1000;
const blockedUntil = new Map<string, number>();

function accountKey(sock: any) {
  return String(sock?.user?.id || "").split(":")[0].split("@")[0];
}

export function buttonsRecentlyUndelivered(sock: any, now = Date.now()) {
  const key = accountKey(sock);
  const until = key ? blockedUntil.get(key) || 0 : 0;
  if (until && until <= now) blockedUntil.delete(key);
  return until > now;
}

export function markButtonUndelivered(sock: any, now = Date.now()) {
  const key = accountKey(sock);
  if (key) blockedUntil.set(key, now + BLOCK_MS);
}

export function markButtonDelivered(sock: any) {
  const key = accountKey(sock);
  if (key) blockedUntil.delete(key);
}

function receiptIds(node: any) {
  const ids = [node?.attrs?.id];
  const list = Array.isArray(node?.content) ? node.content.find((c: any) => c?.tag === "list") : undefined;
  if (list && Array.isArray(list.content)) for (const item of list.content) ids.push(item?.attrs?.id);
  return ids.filter(Boolean).map(String);
}

// Comece a observar ANTES de enviar: o recibo pode chegar em milissegundos.
// Qualquer recibo de aparelho (entregue, lido, "sender" do celular da loja) conta.
// Sem acesso ao socket bruto, assume entregue (comportamento anterior).
export function watchDeviceReceipt(sock: any, messageId: string) {
  const ws = sock?.ws;
  if (!messageId || !ws || typeof ws.on !== "function" || typeof ws.off !== "function") {
    return { wait: async (_ms?: number) => true };
  }
  let received = false;
  let wake: (() => void) | undefined;
  const onReceipt = (node: any) => {
    if (!receiptIds(node).includes(String(messageId))) return;
    received = true;
    wake?.();
  };
  ws.on("CB:receipt", onReceipt);
  return {
    wait: (ms = DEFAULT_TIMEOUT_MS) => new Promise<boolean>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        ws.off("CB:receipt", onReceipt);
        resolve(received);
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      wake = finish;
      if (received) finish();
    }),
  };
}
