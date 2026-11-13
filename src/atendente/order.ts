// Regras determinísticas do pedido: carrinho, entrega, pagamento, resumo e gravação.
// Nada aqui depende da IA: valores vêm do cardápio real e do backend.
import { chatOrder } from "./backend.js";
import { matchScore, resolveOption, resolveProduct, soldOutMatch, type Catalog, type Product } from "./catalog.js";
import { cartFingerprint, freshState, type CartItem, type CartOption, type ConversationState } from "./state.js";
import { brl, cents, clean, norm } from "./text.js";

export type ToolOutcome = Record<string, unknown>;

export const PAYMENT_NAMES: Record<string, string> = {
  pix: "Pix (na entrega)", credit: "cartão de crédito (na entrega)", debit: "cartão de débito (na entrega)",
  money: "dinheiro", online_pix: "Pix online (link de pagamento)", online_credit: "crédito online (link de pagamento)",
  online_debit: "débito online (link de pagamento)",
};

export function paymentId(raw: unknown): string {
  const t = norm(raw).replace(/[^a-z_ ]/g, " ").trim();
  if (/online|link|pelo app|agora/.test(t)) {
    if (/pix/.test(t)) return "online_pix";
    if (/deb/.test(t)) return "online_debit";
    if (/cred|cartao/.test(t)) return "online_credit";
  }
  if (/^(online_pix|online_credit|online_debit|pix|credit|debit|money)$/.test(t)) return t;
  if (/pix/.test(t)) return "pix";
  if (/deb/.test(t)) return "debit";
  if (/cred|cartao|card|maquin/.test(t)) return "credit";
  if (/dinheiro|especie|cash|money|nota/.test(t)) return "money";
  return "";
}

function unitPrice(product: Product, options: CartOption[]) {
  return (cents(product.price) + options.reduce((s, o) => s + cents(o.price) * o.quantity, 0)) / 100;
}

function optionRules(product: Product, options: CartOption[]): string | null {
  for (const group of product.optionGroups || []) {
    const count = options.filter((o) => o.groupId === group.id).reduce((s, o) => s + o.quantity, 0);
    const names = group.options.map((o) => o.name + (o.price ? " (+" + brl(o.price) + ")" : "")).join(", ");
    if (count < group.min) {
      return "Falta escolher em \"" + group.name + "\" (" + (group.min === group.max ? group.min : "de " + group.min + " a " + group.max) +
        "): " + names + ". Pergunte ao cliente UMA vez, com essas opções.";
    }
    if (count > group.max) return "Em \"" + group.name + "\" o máximo é " + group.max + ". Opções: " + names + ".";
  }
  return null;
}

export function addItem(state: ConversationState, catalog: Catalog, args: any): ToolOutcome {
  if (!catalog.store.isOpen) return { erro: "loja_fechada", abre: catalog.store.opensAt, cardapio: catalog.menuUrl };
  const ref = clean(args?.produto, 140);
  if (!ref) return { erro: "Informe o produto." };
  const { product, candidates } = resolveProduct(catalog, ref);
  if (!product) {
    const sold = soldOutMatch(catalog, ref);
    if (sold) return { erro: "esgotado", produto: sold, dica: "Avise que está esgotado e sugira algo parecido do cardápio." };
    if (candidates.length) return { erro: "ambiguo", opcoes: candidates.slice(0, 5).map((p) => p.name + " (" + brl(p.price) + ")"), dica: "Pergunte qual delas, UMA vez, com opções curtas." };
    return { erro: "nao_encontrado", dica: "Não existe no cardápio. Não invente; ofereça itens reais parecidos (use buscar_cardapio)." };
  }
  const quantity = Math.max(1, Math.min(50, Math.floor(Number(args?.quantidade) || 1)));
  const options: CartOption[] = [];
  const notFound: string[] = [];
  for (const raw of Array.isArray(args?.opcoes) ? args.opcoes.slice(0, 20) : []) {
    const found = resolveOption(product, clean(raw, 80));
    if (!found) { notFound.push(clean(raw, 80)); continue; }
    const existing = options.find((o) => o.id === found.option.id);
    if (existing) existing.quantity += 1;
    else options.push({ id: found.option.id, groupId: found.group.id, name: found.option.name, price: found.option.price, quantity: 1 });
  }
  if (notFound.length) {
    const names = (product.optionGroups || []).flatMap((g) => g.options.map((o) => o.name));
    return { erro: "opcao_nao_existe", opcoes_pedidas: notFound, produto: product.name,
      opcoes_disponiveis: names.length ? names : "este produto não tem opções; use observacao para pedidos simples (ex.: sem cebola)" };
  }
  const rule = optionRules(product, options);
  if (rule) return { erro: "faltam_opcoes", produto: product.name, detalhe: rule };
  const notes = clean(args?.observacao, 160);
  const item: CartItem = { productId: product.id, name: product.name, quantity, unitPrice: unitPrice(product, options), options, notes };
  const same = state.items.find((i) => i.productId === item.productId && i.notes === item.notes &&
    JSON.stringify(i.options) === JSON.stringify(item.options));
  if (same) same.quantity = Math.min(50, same.quantity + quantity);
  else state.items.push(item);
  return { ok: true, adicionado: describeItem(item), carrinho: describeCart(state) };
}

export function describeItem(item: CartItem) {
  const opts = item.options.map((o) => (o.quantity > 1 ? o.quantity + "x " : "") + o.name).join(", ");
  return item.quantity + "x " + item.name + (opts ? " (" + opts + ")" : "") + (item.notes ? " [obs: " + item.notes + "]" : "") +
    " — " + brl(item.unitPrice * item.quantity);
}

export function describeCart(state: ConversationState) {
  return state.items.map((item, index) => (index + 1) + ". " + describeItem(item));
}

function findItem(state: ConversationState, args: any): number {
  const n = Number(args?.item_numero);
  if (Number.isInteger(n) && n >= 1 && n <= state.items.length) return n - 1;
  const ref = clean(args?.produto, 140);
  if (!ref) return -1;
  let best = -1; let bestScore = 0.55;
  state.items.forEach((item, index) => {
    const score = matchScore(ref, item.name + " " + item.options.map((o) => o.name).join(" "));
    if (score > bestScore) { best = index; bestScore = score; }
  });
  return best;
}

export function removeItem(state: ConversationState, args: any): ToolOutcome {
  const index = findItem(state, args);
  if (index < 0) return { erro: "item_nao_esta_no_carrinho", carrinho: describeCart(state) };
  const item = state.items[index];
  const qty = Math.floor(Number(args?.quantidade) || 0);
  if (qty > 0 && qty < item.quantity) item.quantity -= qty;
  else state.items.splice(index, 1);
  return { ok: true, carrinho: describeCart(state), vazio: state.items.length === 0 };
}

export function changeItem(state: ConversationState, args: any): ToolOutcome {
  const index = findItem(state, args);
  if (index < 0) return { erro: "item_nao_esta_no_carrinho", carrinho: describeCart(state) };
  const item = state.items[index];
  const qty = Math.floor(Number(args?.nova_quantidade));
  if (Number.isInteger(qty) && qty === 0) state.items.splice(index, 1);
  else if (Number.isInteger(qty) && qty > 0) item.quantity = Math.min(50, qty);
  if (typeof args?.observacao === "string") item.notes = clean(args.observacao, 160);
  return { ok: true, carrinho: describeCart(state) };
}

export function setDelivery(state: ConversationState, catalog: Catalog, args: any): ToolOutcome {
  const tipo = norm(args?.tipo);
  if (/retir|buscar|balcao|pickup/.test(tipo)) { state.delivery = { type: "pickup" }; return { ok: true, entrega: "retirada na loja" }; }
  if (catalog.store.deliveryMode && catalog.store.deliveryMode !== "neighborhood") {
    return { erro: "entrega_so_pelo_cardapio", dica: "Para entrega, esta loja calcula a taxa pelo cardápio digital. Ofereça retirada ou envie o link.", cardapio: catalog.menuUrl };
  }
  const saved = catalog.customer?.savedAddress;
  const useSaved = args?.usar_endereco_salvo === true && saved?.address;
  const address = clean(useSaved ? saved!.address : args?.rua, 250);
  const number = clean(useSaved ? saved!.number : args?.numero, 30);
  let neighborhood = clean(useSaved ? saved!.neighborhood : args?.bairro, 100);
  const complement = clean(args?.complemento ?? (useSaved ? saved!.complement : ""), 160);
  const reference = clean(args?.referencia ?? (useSaved ? saved!.reference : ""), 160);
  const missing = [!address && "rua", !number && "número", !neighborhood && "bairro"].filter(Boolean);
  if (missing.length) return { erro: "endereco_incompleto", falta: missing, dica: "Pergunte só o que falta." };
  const fees = catalog.store.deliveryFees;
  let fee: number | null = null;
  if (fees.length) {
    const ranked = fees.map((f) => ({ f, s: norm(f.name) === norm(neighborhood) ? 1 : matchScore(neighborhood, f.name) }))
      .sort((a, b) => b.s - a.s);
    if (!ranked[0] || ranked[0].s < 0.75 || (ranked[1] && ranked[0].s < 1 && ranked[0].s - ranked[1].s < 0.1)) {
      return { erro: "bairro_fora_da_area", bairro: neighborhood, bairros_atendidos: fees.map((f) => f.name),
        dica: "Diga que não encontrou esse bairro na área de entrega e mostre os mais parecidos, ou ofereça retirada." };
    }
    neighborhood = ranked[0].f.name;
    fee = ranked[0].f.fee;
  }
  state.delivery = { type: "delivery", address, number, neighborhood, complement, reference };
  return { ok: true, entrega: address + ", " + number + " - " + neighborhood + (complement ? " (" + complement + ")" : ""),
    ...(fee !== null ? { taxa_do_bairro: fee } : {}) };
}

export function setPayment(state: ConversationState, catalog: Catalog, args: any): ToolOutcome {
  const id = paymentId(args?.forma);
  const allowed = catalog.store.paymentMethods.map((m) => m.id);
  if (!id || !allowed.includes(id)) {
    return { erro: "forma_invalida", formas_aceitas: catalog.store.paymentMethods.map((m) => m.label) };
  }
  state.payment = id;
  if (id !== "money") state.changeFor = null;
  else if (args?.sem_troco === true) state.changeFor = 0;
  else if (Number(args?.troco_para) > 0) state.changeFor = Math.round(Number(args.troco_para) * 100) / 100;
  return { ok: true, pagamento: PAYMENT_NAMES[id], ...(id === "money" && state.changeFor === null ? { pergunte: "Precisa de troco? Para quanto?" } : {}) };
}

export function setName(state: ConversationState, args: any): ToolOutcome {
  const name = clean(args?.nome, 80).replace(/[^\p{L}\p{M}' .-]/gu, "").trim();
  if (name.length < 2) return { erro: "nome_invalido" };
  state.name = name;
  return { ok: true, nome: name };
}

export function missingForSummary(state: ConversationState): string[] {
  const missing: string[] = [];
  if (!state.items.length) missing.push("itens");
  if (!state.delivery) missing.push("entrega ou retirada (e endereço)");
  if (!state.payment) missing.push("forma de pagamento");
  if (state.payment === "money" && state.changeFor === null) missing.push("troco (para quanto, ou sem troco)");
  if (state.name.trim().length < 2) missing.push("nome do cliente");
  return missing;
}

export function previewBody(sessionId: string, phone: string, state: ConversationState, action: "preview" | "commit") {
  const d = state.delivery;
  return {
    action, sessionId, phone, draftId: state.draftId, name: state.name.trim(),
    items: state.items.map((i) => ({ productId: i.productId, quantity: i.quantity, notes: i.notes,
      selectedOptions: i.options.map((o) => ({ id: o.id, groupId: o.groupId, quantity: o.quantity })) })),
    deliveryType: d?.type || "",
    ...(d?.type === "delivery" ? { address: d.address, number: d.number, neighborhood: d.neighborhood, complement: d.complement, reference: d.reference } : {}),
    paymentMethod: state.payment,
    ...(state.payment === "money" && state.changeFor ? { changeFor: state.changeFor } : {}),
    ...(action === "commit" && state.summary ? { quoteToken: state.summary.quoteToken } : {}),
  };
}

export function formatSummary(state: ConversationState, data: any): string {
  const lines = ["📝 *Resumo do seu pedido*", ""];
  for (const item of Array.isArray(data.items) ? data.items : []) {
    lines.push(item.quantity + "x " + clean(item.name, 140) + " — " + brl(Number(item.total)));
    const opts = (Array.isArray(item.selectedOptions) ? item.selectedOptions : [])
      .map((o: any) => (o.quantity > 1 ? o.quantity + "x " : "") + clean(o.name, 80) + (Number(o.price) ? " (+" + brl(Number(o.price)) + ")" : ""));
    if (opts.length) lines.push("   + " + opts.join(", "));
    if (item.notes) lines.push("   Obs: " + clean(item.notes, 160));
  }
  lines.push("");
  const d = state.delivery;
  if (d?.type === "delivery") {
    lines.push("🛵 Entrega: " + d.address + ", " + d.number + " - " + d.neighborhood + (d.complement ? " (" + d.complement + ")" : ""));
  } else lines.push("🏪 Retirada na loja");
  lines.push("💳 Pagamento: " + (PAYMENT_NAMES[state.payment] || state.payment));
  if (state.payment === "money") lines.push(state.changeFor ? "💵 Troco para " + brl(state.changeFor) : "💵 Sem troco");
  lines.push("👤 Nome: " + state.name.trim());
  lines.push("");
  lines.push("Subtotal: " + brl(Number(data.subtotal)));
  if (d?.type === "delivery") lines.push("Taxa de entrega: " + (Number(data.deliveryFee) > 0 ? brl(Number(data.deliveryFee)) : "grátis"));
  lines.push("*Total: " + brl(Number(data.total)) + "*");
  lines.push("");
  lines.push("Posso confirmar o seu pedido?");
  return lines.join("\n");
}

/** Pede o orçamento ao backend e guarda o resumo. O "sim" só vale para este resumo. */
export async function makeSummary(sessionId: string, phone: string, state: ConversationState): Promise<ToolOutcome & { text?: string }> {
  const missing = missingForSummary(state);
  if (missing.length) return { erro: "faltam_dados", falta: missing, dica: "Pergunte o que falta, de forma curta (uma pergunta só)." };
  const result = await chatOrder(previewBody(sessionId, phone, state, "preview"));
  if (!result.ok) {
    state.summary = null;
    if (result.network || result.status >= 500) return { erro: "sistema_indisponivel" };
    return { erro: "backend_recusou", motivo: clean(result.data?.error, 240) || "Não consegui conferir o pedido.",
      dica: "Explique o motivo ao cliente com suas palavras e ajude a corrigir." };
  }
  const text = formatSummary(state, result.data);
  state.summary = {
    fingerprint: cartFingerprint(state), quoteToken: String(result.data.quoteToken || ""), expires: Number(result.data.expires) || 0,
    total: Number(result.data.total), subtotal: Number(result.data.subtotal), deliveryFee: Number(result.data.deliveryFee), text,
  };
  return { ok: true, text };
}

export function summaryIsCurrent(state: ConversationState) {
  return Boolean(state.summary && state.summary.fingerprint === cartFingerprint(state) && state.items.length);
}

export type CommitResult =
  | { kind: "placed"; text: string }
  | { kind: "changed"; text: string }   // valores mudaram: novo resumo
  | { kind: "refused"; reason: string }
  | { kind: "unavailable" };

/** Grava o pedido. Mesmo draftId => o backend nunca grava duas vezes. */
export async function commitOrder(sessionId: string, phone: string, state: ConversationState, catalog: Catalog): Promise<CommitResult> {
  if (!state.summary) return { kind: "refused", reason: "sem resumo" };
  // Resumo vencido (5 min): confere de novo; se o total mudou, mostra novo resumo.
  if (Date.now() > state.summary.expires - 15_000) {
    const before = state.summary.total;
    const again = await makeSummary(sessionId, phone, state);
    if (!again.ok) return again.erro === "sistema_indisponivel" ? { kind: "unavailable" } : { kind: "refused", reason: String(again.motivo || again.erro) };
    if (cents(state.summary!.total) !== cents(before)) return { kind: "changed", text: "Os valores foram atualizados pela loja:\n\n" + again.text };
  }
  state.committing = true;
  try {
    let result = await chatOrder(previewBody(sessionId, phone, state, "commit"), 20_000);
    if (!result.ok && (result.network || result.status >= 500)) {
      // Resposta incerta: consulta se o pedido entrou antes de qualquer nova tentativa.
      const receipt = await chatOrder({ action: "receipt", sessionId, phone, draftId: state.draftId });
      if (receipt.ok && receipt.data?.found) result = { ok: true, status: 200, data: { ...receipt.data, status: "pending" } };
      else return { kind: "unavailable" };
    }
    if (!result.ok) {
      state.summary = null;
      return { kind: "refused", reason: clean(result.data?.error, 240) || "A loja não aceitou o pedido agora." };
    }
    const data = result.data;
    const number = clean(data.orderNumber, 20);
    const preparing = data.status === "preparing";
    const prep = catalog.store.preparationTime;
    const lines: string[] = [];
    if (data.paymentUrl) {
      lines.push("Pedido *Nº " + number + "* registrado! ✅", "", "Para concluir, faça o pagamento por este link:", String(data.paymentUrl),
        "", "A loja recebe o pedido assim que o pagamento for aprovado.");
    } else if (preparing) {
      lines.push("Pedido *Nº " + number + "* confirmado! ✅ Já está em preparo 👨‍🍳");
      if (prep) lines.push("Previsão: " + prep.min + (prep.max > prep.min ? " a " + prep.max : "") + " min.");
    } else {
      lines.push("Seu pedido *Nº " + number + "* foi enviado para a loja! ✅", "Te aviso assim que for aceito.");
    }
    lines.push("", "Para acompanhar, é só mandar *acompanhar pedido*. Obrigado! 😊");
    const placed = { orderId: String(data.orderId || ""), orderNumber: number, at: Date.now(), draftId: state.draftId };
    const keepName = state.name;
    Object.assign(state, freshState(), { lastPlaced: placed, name: keepName, history: state.history, greetedAt: state.greetedAt });
    return { kind: "placed", text: lines.join("\n") };
  } finally {
    state.committing = false;
  }
}
