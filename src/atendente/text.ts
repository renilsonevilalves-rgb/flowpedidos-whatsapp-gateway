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

/** Verbo de acrescentar: "adicionar", "coloca", "inclui", "mais uma", "esqueci"... */
export function wantsToAdd(text: string): boolean {
  return /\b(adicion\w*|acrescent\w*|coloc\w*|inclu\w*|bota|botar|boto|poe|por tambem|junta\w*|mais um|mais uma|esqueci\w*|faltou)\b/.test(norm(text));
}

/** Fala explicitamente de um pedido JÁ FEITO ("no pedido que acabei de fazer", "no meu pedido", "pedido 2473"). */
export function refersToPlacedOrder(text: string): boolean {
  const t = norm(text);
  return /(pedido (?:que |q )?(?:eu )?(?:acabei|fiz|mandei|pedi|enviei|ja fiz)|acabei de (?:fazer|pedir|mandar)|pedido anterior|pedido (?:ja )?(?:feito|enviado|confirmado)|ultimo pedido|\b(?:no|ao|nesse|neste|naquele|junto (?:com|ao|do)) (?:meu |mesmo |ultimo |outro )?pedido\b(?! novo)|meu pedido|pedido\s*(?:#|n[°º.o]?\.?|numero)?\s*\d{3,}|#\d{3,})/.test(t);
}

/** Trocar a forma de pagamento ("quero pagar na entrega", "muda pro pix", "colocar para pagar no cartão"). */
export function wantsPaymentChange(text: string): boolean {
  const t = norm(text);
  if (/\b(troc|mud|alter)\w* (?:a |o )?(?:forma de )?pagamento\b/.test(t)) return true;
  if (!/\b(pag\w*)\b/.test(t)) return false;
  // "adicionar uma bebida para pagar no pix" é item novo; "colocar para pagar na entrega" é pagamento.
  if (wantsToAdd(text) && !/\b(coloc\w*|bota\w*|poe) (?:pra|para|o pagamento|a forma)\b/.test(t)) return false;
  return /\b(na entrega|na hora|no local|pessoalmente|quando chegar|em dinheiro|no dinheiro|em especie|no cartao|no debito|no credito|no pix|via pix|outra forma)\b/.test(t) ||
    /\b(troc|mud|alter)\w*\b/.test(t);
}

/** Mensagem que é só o número de um pedido ("2248", "nº 2248", "#2248"). */
export function isOrderNumberOnly(text: string): boolean {
  return /^(?:o |no |do )?(?:pedido\s*)?(?:n[°º.o]?\s*|numero\s*)?#?\s*\d{3,6}\s*[.!]?$/.test(norm(text));
}

export function wantsToCancel(text: string): boolean {
  return /\b(cancel\w*|desist\w*|nao quero mais|esquece (?:o|esse) pedido)\b/.test(norm(text));
}

/** Resposta à pergunta "este carrinho ou o pedido Nº X?": "draft" | "placed" | "". */
export function choiceAnswer(text: string): "draft" | "placed" | "" {
  const t = norm(text).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(novo|nova|carrinho|rascunho|resumo|este|esse|essa|esta|agora|atual|montando|1)\b/.test(t) && !/\b(feito|anterior|acabei|fiz|mandei|enviado|ja)\b/.test(t)) return "draft";
  if (/\b(feito|anterior|acabei|fiz|mandei|enviado|ja|outro|aquele|antigo|primeiro|2|pedido)\b/.test(t) || /\d{3,}/.test(t)) return "placed";
  return "";
}
