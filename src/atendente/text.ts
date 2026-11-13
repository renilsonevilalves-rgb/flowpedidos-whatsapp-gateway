// Utilitários de texto do atendente: normalização, dinheiro e respostas curtas.

export function norm(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\s+/g, " ").trim();
}

export function clean(value: unknown, limit = 200): string {
  return String(value ?? "").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ").trim().slice(0, limit);
}

export function brl(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0)
    .replace(/ /g, " ");
}

export const cents = (value: number) => Math.round(Number(value) * 100);

/** "sim", "pode", "confirma", "isso", "pode mandar", "fechado"... sem nenhuma alteração junto. */
export function isPureYes(text: string): boolean {
  const t = norm(text).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 6) return false;
  if (/\b(mas|porem|so que|troca|trocar|muda|mudar|tira|tirar|adiciona|coloca|sem|com|nao|outro|outra)\b/.test(t)) return false;
  return /^(?:(?:sim|s|ss|sss|isso|isso mesmo|exato|pode|pode sim|pode ser|pode mandar|pode enviar|pode confirmar|pode fechar|manda|mande|manda ai|envia|confirma|confirmo|confirmado|confirmar|fechado|fecha|fechou|ok|okay|blz|beleza|certo|ta certo|correto|perfeito|tudo certo|ta otimo|otimo|bora|vamos|claro|uhum|aham|yes|positivo|isso ai|pode ir|manda bala)\s*)+(?:por favor|pfv|pf|obrigad[oa])?$/.test(t);
}

export function isPureNo(text: string): boolean {
  const t = norm(text).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:nao|n|nn|nao quero|negativo|nem|ainda nao)$/.test(t);
}

/** Saudação sozinha ("boa noite", "oi tudo bem?", "olá boa tarde"). */
export function isOnlyGreeting(text: string): boolean {
  const t = norm(text).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/(.)\1{2,}/g, "$1$1");
  if (!t || t.split(" ").length > 6) return false;
  return /^(?:(?:oi+|oie|ola|ole|opa|eai|e ai|hey|hello|alo|bom dia|boa tarde|boa noite|boa|tudo bem|tudo bom|td bem|como vai|blz|beleza|salve)\s*)+$/.test(t);
}

export function wantsHuman(text: string): boolean {
  const t = norm(text);
  return /\b(atendente|atendimento humano|humano|falar com (?:alguem|uma pessoa|pessoa|o dono|a dona|a loja|o gerente|funcionario)|pessoa de verdade|quero falar com)\b/.test(t) &&
    !/\b(robo|bot|assistente)\b/.test(t);
}

/** Assuntos de pedido JÁ FEITO: ficam com o atendimento atual de pedidos. */
export function aboutPlacedOrder(text: string): boolean {
  const t = norm(text);
  return /(meu pedido|pedido anterior|pedido que (?:eu )?(?:fiz|mandei|pedi|enviei)|acabei de (?:fazer|pedir|mandar)|ultimo pedido|cade (?:o )?(?:meu )?pedido|status do pedido|rastrear|acompanhar|alterar (?:o )?pedido|cancelar (?:o |meu )?pedido|pedido\s*(?:#|n[°º.]|numero)\s*\d{2,}|#\d{3,}|demora|vai demorar|ja saiu|saiu pra entrega|esta vindo|ta vindo)/.test(t);
}

export function levenshtein(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
