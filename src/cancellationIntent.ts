// A request to cancel an existing order is different from editing a cart,
// cancelling a product, or asking a hypothetical question about cancellation.
// This classifier only starts a lookup and confirmation; it never cancels.
const normalize = (value: unknown): string => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9#]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

export function isOrderCancellationRequest(value: unknown): boolean {
  const text = normalize(value);
  if (!text || text.length > 320) return false;

  // Do not turn negations, hypothetical questions or cancellation of something
  // else into an existing-order operation.
  if (/\b(?:nao|nunca|jamais)\s+(?:quero\s+|vou\s+|precisa\s+|e\s+pra\s+)?(?:cancelar|cancela(?:r|mento)?|cancele|cansela(?:r)?|desfazer|anular)\b/.test(text) ||
      /\b(?:nao\s+)?(?:cancelar|cancela|cancele|cansela)\s+nao\b/.test(text) ||
      /\b(?:se|caso)\s+(?:eu\s+)?(?:cancelar|cancele|cancelo|cancelasse|desistir)\b/.test(text) ||
      /\b(?:como funciona|o que acontece|quais as regras|qual o prazo|tem multa|politica de cancelamento)\b/.test(text)) return false;

  if (/\b(?:cancelar|cancela|cancele|cancelamento|canselar|cansela|desfazer|anular|desistir)\b.{0,50}\b(?:assinatura|cadastro|conta|cupom|promocao|notificacao|agendamento|reserva|pagamento|pix|cartao|cobranca|taxa|entrega)\b/.test(text)) return false;

  // Removal of one or more items belongs to the product-change flow.
  if (/\b(?:cancelar|cancela|cancele|cansela|desfazer|anular)\b.{0,48}\b(?:so|somente|apenas|um|uma|1|2|dois|duas)\s+(?:(?:dos?|das?|o|a|meus?|minhas?)\s+)?(?:item|itens|produtos?|coxinhas?|lanches?|pizzas?|refrigerantes?)\b/.test(text) ||
      /\b(?:cancelar|cancela|cancele|cansela)\s+(?:o|a)\s+(?:item|produto)\b/.test(text)) return false;

  const direct = /\b(?:cancelar|cancela|cancele|cancelo|cancelamento|canselar|cansela|kancela|anular|anula)\b/;
  const wants = /\b(?:quero|queria|preciso|pode|poderia|gostaria|vou|favor|pfv|por favor|me ajuda|tem como|da pra|d[aá] pra|solicito|solicitar|faz|fazer|realizar|manda|manda ai)\b/;
  const order = /\b(?:pedido|pedidos|compra|comanda|encomenda|#\s*\d{2,})\b/;

  if (direct.test(text)) {
    if (/\bcancelamento\b/.test(text) && !wants.test(text) && !order.test(text)) return false;
    // 'O cancelamento do pedido foi feito?' is a status question, not a request.
    if (/\b(?:ja|foi|esta|ta)\s+cancelad[oa]\b|\bcancelamento\b.{0,30}\b(?:foi feito|deu certo|concluido)\b/.test(text)) return false;
    // A lone verb ('cancelar', 'cancela') is an actionable command; it still
    // requires a real order lookup and the customer's explicit confirmation.
    return true;
  }

  if (/\b(?:desisti|desistimos|desistir|desistiu|nao quero mais|nao vou querer mais|nao precisa mais|deixa pra la|deixa para la|esquece|desfazer|desfaz|desfaca|anular)\b/.test(text) &&
      (order.test(text) || /\b(?:tudo|a compra|o pedido)\b/.test(text))) return true;

  // Short replies often follow an order receipt with no repeated 'pedido'.
  return /^(?:nao quero mais|nao vou querer mais|cancela tudo|cancela ai|pode cancelar|quero cancelar|queria cancelar|quero desistir)\s*(?:por favor|pfv|obrigad[oa])?$/.test(text);
}
