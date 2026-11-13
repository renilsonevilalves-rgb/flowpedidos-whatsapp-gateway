// Atendente de pedidos pelo WhatsApp (conversa livre, sem botões e sem menu de números).
// O Gemini conversa e escolhe ferramentas; preço/taxa/total vêm do backend e a
// confirmação ("sim" para o resumo mais recente) é decidida pelo código.
import { chatOrder, backendConfigured } from "./backend.js";
import { describeProduct, searchProducts, soldOutMatch, type Catalog } from "./catalog.js";
import { generate, GeminiUnavailable, type GeminiContent, type GeminiPart } from "./gemini.js";
import {
  addItem, changeItem, commitOrder, describeCart, makeSummary, missingForSummary, PAYMENT_NAMES,
  checkIfoodPayment, ifoodPaymentLines, ifoodPaymentsText, removeItem, setDelivery, setName, setPayment, summaryIsCurrent, type ToolOutcome,
} from "./order.js";
import { randomInt } from "node:crypto";
import { findSessionByAddressLink, freshState, getSession, persist, type CartItem, type ConversationState, type IfoodPaymentOption, type Session } from "./state.js";
import {
  aboutPlacedOrder, brl, choiceAnswer, clean, isOnlyGreeting, isOrderNumberOnly, isPureYes, norm, refersToPlacedOrder, wantsHuman,
  wantsPaymentChange, wantsToAdd, wantsToCancel,
} from "./text.js";
import { FATIMA_TENANT_ID } from "../fatimaHandoff.js";

export type AtendenteParams = {
  sessionId: string;
  customerJid: string;
  customerPhone: string | null;
  customerName?: string | null;
  text: string;
  /** Pedido já feito com conversa pendente no atendimento atual (cancelar/alterar). */
  legacyBusy?: boolean;
  sendMessage: (text: string) => Promise<void>;
  pauseForHuman: () => Promise<void>;
  periodGreeting: () => string;
  logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
};

const CATALOG_TTL_MS = 5 * 60_000;
const DEBOUNCE_MS = Number(process.env.ATENDENTE_DEBOUNCE_MS ?? 1500);
const MAX_TOOL_ROUNDS = 6;

export function atendenteTenants(): Set<string> {
  return new Set(String(process.env.WHATSAPP_AI_ORDER_TENANTS || "").split(",").map((v) => v.trim()).filter(Boolean));
}
/** "*" = toda loja cujo plano permite (Ultra/teste); o servidor confere o plano a cada passo. */
export function isAtendenteTenant(sessionId: string): boolean {
  const tenants = atendenteTenants();
  if (!tenants.has(sessionId) && !tenants.has("*")) return false;
  return Date.now() >= (catalogDeniedUntil.get(sessionId) || 0);
}
// Loja sem permissão (plano sem pedido pela conversa): não pergunta de novo por 10 min.
const catalogDeniedUntil = new Map<string, number>();

/** Link curto para o WhatsApp: clickaipedidos.com.br/loja (abre /cardapio/loja). */
export function shortMenuLink(url: string): string {
  return String(url || "").replace(/^https?:\/\/(?:www\.)?clickaipedidos\.com\.br\/cardapio\//i, "clickaipedidos.com.br/");
}

// ---------------------------------------------------------------------------
// Cardápio (cache de 5 min por cliente; o perfil do cliente vem junto)
async function ensureCatalog(session: Session, p: AtendenteParams): Promise<Catalog | null> {
  if (session.catalog && Date.now() - (session.catalogAt || 0) < CATALOG_TTL_MS) return session.catalog;
  const result = await chatOrder({ action: "catalog", sessionId: p.sessionId, phone: p.customerPhone || "" });
  if (result.ok && Array.isArray(result.data?.products) && result.data?.store) {
    const d = result.data;
    session.catalog = {
      storeName: clean(d.storeName, 120), menuUrl: shortMenuLink(clean(d.menuUrl, 300)), products: d.products,
      soldOut: Array.isArray(d.soldOut) ? d.soldOut : [], store: d.store, customer: d.customer || null,
      learnedAliases: Array.isArray(d.learnedAliases) ? d.learnedAliases : [],
    };
    session.catalogAt = Date.now();
    return session.catalog;
  }
  if (result.status === 403) catalogDeniedUntil.set(p.sessionId, Date.now() + 10 * 60_000);
  p.logger.warn({ sessionId: p.sessionId, status: result.status }, "[Atendente] Catálogo indisponível");
  return session.catalog || null;
}

// ---------------------------------------------------------------------------
// Ferramentas do Gemini
const S = (description: string) => ({ type: "STRING", description });
const TOOLS = [
  { name: "buscar_cardapio", description: "Busca produtos reais do cardápio com as opções de cada um (aceita erros de digitação e apelidos). Use quando precisar ver sabores/tamanhos/bordas/adicionais ou quando o produto não estiver claro no CARDÁPIO. Produto simples e claro: chame adicionar_item direto.",
    parameters: { type: "OBJECT", properties: { termo: S("o que o cliente pediu, ex.: 'pizza media', 'coca 2l', 'calabresa'") }, required: ["termo"] } },
  { name: "adicionar_item", description: "Adiciona um produto ao carrinho assim que o cliente disser o que quer. Opções = sabores (meio a meio = 2 sabores), tamanho, borda, adicionais, exatamente como existem no produto.",
    parameters: { type: "OBJECT", properties: {
      produto: S("id do produto (de buscar_cardapio) ou o nome"),
      quantidade: { type: "INTEGER", description: "padrão 1" },
      opcoes: { type: "ARRAY", items: { type: "STRING" }, description: "nomes das opções escolhidas (repita o nome para 2 unidades)" },
      observacao: S("pedido simples sem custo, ex.: 'sem cebola', 'bem passado'"),
    }, required: ["produto"] } },
  { name: "remover_item", description: "Remove um item do carrinho (ou só parte da quantidade).",
    parameters: { type: "OBJECT", properties: { item_numero: { type: "INTEGER", description: "número do item no carrinho" }, produto: S("nome do item"), quantidade: { type: "INTEGER", description: "quantas unidades tirar; vazio = todas" } } } },
  { name: "alterar_item", description: "Muda a quantidade ou a observação de um item do carrinho. Para trocar sabor/borda/adicional, remova e adicione de novo.",
    parameters: { type: "OBJECT", properties: { item_numero: { type: "INTEGER", description: "número do item" }, produto: S("nome do item"), nova_quantidade: { type: "INTEGER", description: "nova quantidade" }, observacao: S("nova observação") } } },
  { name: "definir_entrega", description: "Define entrega (com endereço) ou retirada. Em loja com entrega iFood, devolve um link para o cliente preencher o endereço. Use usar_endereco_salvo=true quando o cliente aceitar o endereço do último pedido.",
    parameters: { type: "OBJECT", properties: {
      tipo: S("'entrega' ou 'retirada'"), usar_endereco_salvo: { type: "BOOLEAN", description: "usar o endereço do último pedido" },
      rua: S("rua/avenida"), numero: S("número"), bairro: S("bairro"), complemento: S("apto, bloco, casa"), referencia: S("ponto de referência"),
    }, required: ["tipo"] } },
  { name: "definir_pagamento", description: "Define a forma de pagamento (pix, credito, debito, dinheiro ou online). Para dinheiro, informe troco_para ou sem_troco.",
    parameters: { type: "OBJECT", properties: { forma: S("pix | credito | debito | dinheiro | pix online | credito online | debito online"),
      troco_para: { type: "NUMBER", description: "valor em reais para o troco" }, sem_troco: { type: "BOOLEAN", description: "true se não precisa de troco" },
      bandeira: S("bandeira do cartão (Visa, Mastercard, Elo...), quando a entrega é pelo iFood e o pagamento é cartão na entrega") }, required: ["forma"] } },
  { name: "definir_nome", description: "Define o nome do cliente para o pedido.",
    parameters: { type: "OBJECT", properties: { nome: S("nome do cliente") }, required: ["nome"] } },
  { name: "gerar_resumo", description: "Calcula os valores oficiais (subtotal, taxa, total) e envia o resumo ao cliente pedindo confirmação. Chame quando itens, entrega/endereço, pagamento e nome estiverem definidos, e de novo sempre que algo mudar depois de um resumo.",
    parameters: { type: "OBJECT", properties: {} } },
  { name: "adicionar_ao_pedido_feito", description: "SÓ no modo ADICIONAR AO PEDIDO JÁ FEITO: envia para a loja o item escolhido para ser acrescentado ao pedido que o cliente já fez.",
    parameters: { type: "OBJECT", properties: {
      produto: S("id do produto (de buscar_cardapio) ou o nome"),
      quantidade: { type: "INTEGER", description: "padrão 1" },
      opcoes: { type: "ARRAY", items: { type: "STRING" }, description: "opções escolhidas" },
      observacao: S("observação simples"),
    }, required: ["produto"] } },
  { name: "sair_modo_adicionar", description: "O cliente desistiu de acrescentar ao pedido já feito e quer fazer um pedido NOVO.", parameters: { type: "OBJECT", properties: {} } },
  { name: "cancelar_rascunho", description: "Descarta o pedido em montagem quando o cliente desistir.", parameters: { type: "OBJECT", properties: {} } },
  { name: "chamar_atendente", description: "Pausa o robô e chama uma pessoa da loja para este cliente.", parameters: { type: "OBJECT", properties: {} } },
];

type TurnFlags = { summary?: string; handoff?: boolean; reroute?: string };

async function runTool(name: string, args: any, ctx: { p: AtendenteParams; state: ConversationState; catalog: Catalog; flags: TurnFlags }): Promise<ToolOutcome> {
  const { p, state, catalog } = ctx;
  if (state.addToPlaced && name === "adicionar_item") name = "adicionar_ao_pedido_feito";
  switch (name) {
    case "adicionar_ao_pedido_feito": {
      if (!state.addToPlaced) return { erro: "use adicionar_item: o cliente está montando um pedido novo" };
      const temp = freshState();
      const result = addItem(temp, catalog, args);
      if ("erro" in result) return result;
      ctx.flags.reroute = addToPlacedText(state.addToPlaced.orderNumber, temp.items.map(describeItemPlain), state.addToPlaced.payment);
      state.lastReroute = { items: norm(temp.items.map(describeItemPlain).join("; ")), at: Date.now() };
      return { ok: true, enviado: "Pedido de alteração enviado para a loja." };
    }
    case "sair_modo_adicionar": state.addToPlaced = null; return { ok: true, modo: "pedido novo" };
    case "buscar_cardapio": {
      const term = clean(args?.termo, 120);
      const found = searchProducts(catalog, term, 8);
      const sold = soldOutMatch(catalog, term);
      if (!found.length) return { resultados: [], ...(sold ? { esgotado: sold } : {}), dica: "Nada parecido no cardápio. Não invente." };
      return { resultados: found.map((m) => describeProduct(m.product)), ...(sold ? { esgotado: sold } : {}) };
    }
    case "adicionar_item": {
      // Pergunta ("tem pão de sal?", "e pão de sal?", "quanto é a coca?") não é pedido: só responde.
      const lastUser = [...state.history].reverse().find((t) => t.role === "user")?.text || "";
      if (isOnlyQuestion(lastUser) && !state.addToPlaced) {
        return { erro: "cliente_so_perguntou", dica: "O cliente só perguntou se tem/quanto custa. NÃO adicione. Responda com o produto e o preço e pergunte se quer pedir." };
      }
      return addItem(state, catalog, args);
    }
    case "remover_item": return removeItem(state, args);
    case "alterar_item": return changeItem(state, args);
    case "definir_entrega": {
      // Entrega iFood: o cliente preenche o endereço num link e a cotação oficial volta para cá.
      if (catalog.store.deliveryMode === "ifood" && !/retir|buscar|balcao|pickup/.test(norm(args?.tipo))) {
        if (state.delivery?.type === "delivery" && state.delivery.ifood && !ifoodQuoteExpired(state) && !args?.rua && !args?.trocar_endereco) {
          return { ok: true, entrega: state.delivery.address + ", " + state.delivery.number + " - " + state.delivery.neighborhood, taxa_ifood: state.delivery.ifood.fee };
        }
        const link = createAddressLink(p, state, catalog);
        return { ok: true, aguardando_endereco: true, link,
          dica: "Mande este link numa mensagem curta: o cliente preenche o endereço e vê a taxa do iFood; assim que confirmar, a conversa continua aqui sozinha. Não peça o endereço por mensagem." };
      }
      // Endereço novo sem bairro: a IA não pode presumir o bairro do último pedido (a taxa muda).
      const saved = catalog.customer?.savedAddress;
      const recentUser = norm(state.history.filter((t) => t.role === "user").slice(-3).map((t) => t.text).join(" "));
      if (args?.usar_endereco_salvo !== true && saved?.neighborhood && args?.bairro && args?.rua &&
        norm(args.bairro) === norm(saved.neighborhood) && norm(args.rua) !== norm(saved.address) &&
        !recentUser.includes(norm(saved.neighborhood))) {
        return { erro: "confirmar_bairro", dica: "O cliente passou um endereço novo sem dizer o bairro. Pergunte qual é o bairro; não presuma " + saved.neighborhood + "." };
      }
      return setDelivery(state, catalog, args);
    }
    case "definir_pagamento": return setPayment(state, catalog, args);
    case "definir_nome": {
      const result = setName(state, args);
      if (!("erro" in result)) state.nameSource = "customer";
      return result;
    }
    case "gerar_resumo": {
      if (!catalog.store.isOpen) return { erro: "loja_fechada", abre: catalog.store.opensAt };
      if (ifoodQuoteExpired(state)) {
        return { erro: "taxa_ifood_expirada", link: createAddressLink(p, state, catalog),
          dica: "A taxa do iFood vale por pouco tempo e venceu. Mande este link para o cliente confirmar o endereço de novo." };
      }
      const result = await makeSummary(p.sessionId, String(p.customerPhone), state);
      if (result.ok && result.text) { ctx.flags.summary = result.text; return { ok: true, enviado: "O sistema enviou o resumo ao cliente. Não escreva valores." }; }
      return result;
    }
    case "cancelar_rascunho": {
      clearDraft(state);
      return { ok: true, carrinho: [] };
    }
    case "chamar_atendente": ctx.flags.handoff = true; return { ok: true };
    default: return { erro: "ferramenta_desconhecida" };
  }
}

// ---------------------------------------------------------------------------
function storeBlock(catalog: Catalog, state?: ConversationState): string {
  const ifoodLines = state ? ifoodPaymentLines(state, catalog) : [];
  const s = catalog.store;
  const lines = [
    "Loja: " + catalog.storeName,
    "Link do cardápio: " + catalog.menuUrl,
    s.isOpen ? "Situação: ABERTA agora" + (s.closesAt ? ", fecha às " + s.closesAt : "") : "Situação: FECHADA agora" + (s.opensAt ? "; abre " + s.opensAt : "") + ". Não monte pedido.",
    s.text ? "Horários: " + s.text : "",
    ifoodLines.length
      ? "Pagamentos disponíveis AGORA nesta entrega iFood (ofereça só estes, um por linha, exatamente assim):\n" + ifoodLines.join("\n")
      : state?.delivery?.type === "delivery" && state.delivery.ifood
        ? "Pagamentos nesta entrega iFood: nenhuma forma disponível agora; ofereça retirada na loja."
        : "Pagamentos aceitos: " + s.paymentMethods.map((m) => m.label).join(", "),
    s.minimumOrderValue ? "Pedido mínimo (produtos): " + brl(s.minimumOrderValue) : "",
    s.preparationTime ? "Tempo de preparo: " + s.preparationTime.min + "-" + s.preparationTime.max + " min" : "",
    s.deliveryMode === "neighborhood"
      ? (s.deliveryFees.length ? "Taxas de entrega por bairro: " + s.deliveryFees.map((f) => f.name + " " + brl(f.fee)).join("; ") : "Entrega: sem taxa cadastrada")
      : s.deliveryMode === "ifood"
        ? "Entrega: pelo iFood. NUNCA peça o endereço por mensagem: chame definir_entrega com tipo 'entrega' e mande o link que ela devolver; a taxa sai lá."
        : "Entrega: taxa calculada só pelo cardápio digital (ofereça retirada ou o link)",
    "Retirada na loja: sim" + (s.address ? " (" + s.address + ")" : ""),
  ];
  return lines.filter(Boolean).join("\n");
}

function menuBlock(catalog: Catalog): string {
  const byCat = new Map<string, string[]>();
  for (const p of catalog.products.slice(0, 300)) {
    const cat = p.category || "Outros";
    const extra = p.optionGroups?.length ? " [tem opções: " + p.optionGroups.map((g) => g.name).join(", ") + "]" : "";
    byCat.set(cat, [...(byCat.get(cat) || []), p.name + " " + brl(p.price) + extra]);
  }
  const lines = [...byCat].map(([cat, items]) => "• " + cat + ": " + items.join(" | "));
  if (catalog.soldOut.length) lines.push("ESGOTADOS hoje: " + catalog.soldOut.map((p) => p.name).join(", "));
  return lines.join("\n");
}

function stateBlock(state: ConversationState, catalog: Catalog, firstName: string): string {
  const c = catalog.customer;
  const saved = c?.savedAddress;
  const d = state.delivery;
  const lines = [
    "Nome do cliente: " + (state.name || "(não informado)") + (firstName ? " (chame de " + firstName + ")" : "") +
      (state.name && state.nameSource === "whatsapp" ? " — veio do perfil do WhatsApp; se não parecer nome de pessoa (ex.: 'Consultor', 'Loja', apelido), antes do resumo pergunte só 'Qual o seu nome?' (sem citar o nome do WhatsApp)" : ""),
    catalog.store.deliveryMode === "ifood"
      ? "Entrega iFood: NÃO ofereça o endereço nem o pagamento do último pedido. Pergunte se é entrega ou retirada; para entrega chame definir_entrega e mande o link (o último endereço já vem preenchido nele). O pagamento é escolhido depois, só entre as formas disponíveis."
      : saved?.address ? "Endereço do último pedido: " + saved.address + ", " + saved.number + " - " + saved.neighborhood + (saved.complement ? " (" + saved.complement + ")" : "") : "Sem endereço salvo",
    c?.lastOrder?.paymentMethod && catalog.store.deliveryMode !== "ifood" ? "Pagamento do último pedido: " + (PAYMENT_NAMES[c.lastOrder.paymentMethod] || c.lastOrder.paymentMethod) : "",
    "CARRINHO: " + (state.items.length ? "\n  " + describeCart(state).join("\n  ") : "vazio"),
    "Entrega: " + (!d ? (state.addressLinkId ? "(link de endereço enviado, aguardando o cliente preencher)" : "(não definida)") : d.type === "pickup" ? "retirada"
      : d.address + ", " + d.number + " - " + d.neighborhood + (d.ifood ? " — taxa iFood " + brl(d.ifood.fee) + "; entregador aceita: " + (ifoodPaymentsText(d.ifood.payments) || "só pagamento online") : "")),
    state.ifoodPayment ? "Pagamento na entrega iFood: " + state.ifoodPayment.method + (state.ifoodPayment.brand ? " " + state.ifoodPayment.brand : "") : "",
    "Pagamento: " + (state.payment ? PAYMENT_NAMES[state.payment] : "(não definido)") + (state.payment === "money" ? (state.changeFor === null ? ", troco não perguntado" : state.changeFor ? ", troco para " + brl(state.changeFor) : ", sem troco") : ""),
    state.items.length ? "Ainda falta: " + (missingForSummary(state).join(", ") || "nada — pode chamar gerar_resumo") : "",
    state.summary ? (summaryIsCurrent(state) ? "Resumo já enviado e atual: aguardando o cliente confirmar." : "O pedido mudou depois do último resumo: chame gerar_resumo de novo.") : "",
    state.lastPlaced && Date.now() - state.lastPlaced.at < RECENT_ORDER_MS
      ? "Pedido JÁ FEITO nesta conversa: Nº " + state.lastPlaced.orderNumber + " (há " + Math.max(1, Math.round((Date.now() - state.lastPlaced.at) / 60_000)) + " min). Os itens dele NÃO estão no carrinho e não devem voltar para ele." : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function systemPrompt(state: ConversationState, catalog: Catalog, firstName: string): string {
  return [
    "Você é o atendente virtual de pedidos de um delivery no WhatsApp. Fale em português do Brasil, curto e simpático (no máximo 1 ou 2 emojis por mensagem). Nada de menus numerados, nada de botões.",
    "REGRAS:",
    "1. Nunca invente produto, sabor, tamanho, preço, taxa ou total. Use só o cardápio abaixo e as ferramentas. Na dúvida, chame buscar_cardapio.",
    "2. Quando o cliente PEDIR um item (quero, me vê, manda, vou querer, 2 pães...), chame adicionar_item na hora. Se ele só PERGUNTAR (tem X? e X? quanto custa?), responda e pergunte se quer pedir; não adicione.",
    "2b. Ao listar 2 ou mais produtos, use uma linha por produto, assim: • Coca-Cola 2L — R$ 13,90",
    "3. Se adicionar_item disser que faltam opções (tamanho, sabor, borda...), ou que está ambíguo, pergunte UMA vez com as opções curtas.",
    "4. Depois do item, se faltar entrega/pagamento e houver endereço e pagamento do último pedido, pergunte numa frase só: 'Posso usar a entrega na <rua>, nº <número> e o pagamento no <forma>, como no seu último pedido?'. Sem histórico: pergunte se é entrega ou retirada e o endereço; depois a forma de pagamento. Dinheiro: pergunte o troco.",
    "5. Nunca pergunte de novo algo que já está no ESTADO ATUAL. Faça uma pergunta por vez.",
    "6. Quando não faltar nada, chame gerar_resumo: o sistema envia o resumo com os valores oficiais. Você não escreve total nem resumo.",
    "7. Se o cliente mudar algo (item, endereço, pagamento, troco) depois do resumo, aplique a mudança com a ferramenta e chame gerar_resumo de novo.",
    "8. Você não confirma pedido: a confirmação é feita pelo sistema quando o cliente responde 'sim' ao resumo. Se o resumo atual estiver aguardando, termine com 'Posso confirmar o seu pedido?'.",
    "9. Produto esgotado: diga que acabou e sugira algo parecido que exista. Loja fechada: informe quando abre e mande o link do cardápio; não monte pedido.",
    "10. Perguntas sobre horário, taxa, pagamento, pedido mínimo: responda com os dados da LOJA abaixo. Quem quiser ver o cardápio: mande o link exato.",
    "11. Cliente pediu atendente/pessoa: chame chamar_atendente. Desistiu do pedido: chame cancelar_rascunho.",
    "12. Mensagem confusa: interprete com bom senso (erros de digitação são normais); se continuar sem entender, pergunte de forma simples.",
    "13. 'ela', 'ele', 'isso', 'esse', 'essa' se referem ao item já citado. Uma correção do cliente ('na verdade...', 'não, é...') NUNCA vira item novo; só aumente a quantidade quando ele pedir claramente mais unidades.",
    "14. Nunca chame chamar_atendente sem o cliente pedir para falar com uma pessoa.",
    "15. Só diga 'mais um'/'mais uma' se o item já estava no CARRINHO antes. Carrinho vazio = primeiro item.",
    "16. Pedido já feito (veja ESTADO ATUAL): nunca recoloque os itens dele no carrinho nem gere resumo com eles. Mudança de pagamento, endereço ou itens de um pedido já feito é tratada pela loja, não monte pedido novo para isso.",
    "17. Se o cliente disser só 'cartão' e a loja aceitar crédito e débito, pergunte se é crédito ou débito.",
    "18. Localização pelo mapa: agradeça e peça rua, número e bairro por escrito (a taxa é pelo bairro); em loja com entrega iFood, mande o link de endereço (regra 19).",
    "19. Loja com entrega pelo iFood: para entrega, chame definir_entrega (tipo 'entrega') e mande o link que ela devolver, explicando que é só para preencher o endereço e ver a taxa. Não peça rua/número/bairro por mensagem. Na entrega iFood o entregador não recebe Pix; se for cartão na entrega, pergunte a bandeira e passe em definir_pagamento (bandeira). Formas de pagamento: ofereça só as da lista 'Pagamentos disponíveis AGORA', uma por linha começando com •, nunca as outras.",
    state.addToPlaced
      ? "\nMODO ADICIONAR AO PEDIDO JÁ FEITO" + (state.addToPlaced.orderNumber ? " Nº " + state.addToPlaced.orderNumber : "") +
        ": o cliente quer ACRESCENTAR itens ao pedido que já fez. Mostre as opções reais (buscar_cardapio) e, quando ele escolher, chame adicionar_ao_pedido_feito. NÃO use adicionar_item nem gerar_resumo e não pergunte endereço. Se ele disser que quer um pedido novo, chame sair_modo_adicionar."
      : "",
    "",
    "LOJA:\n" + storeBlock(catalog, state),
    "",
    "CARDÁPIO (preços reais):\n" + menuBlock(catalog),
    "",
    "ESTADO ATUAL DO PEDIDO:\n" + stateBlock(state, catalog, firstName),
  ].join("\n");
}

function sanitizeReply(text: string, catalog: Catalog): string {
  let out = String(text || "").trim();
  out = out.replace(/https?:\/\/\S*\/cardapio\/[^\s)*]*/gi, catalog.menuUrl);
  // Valor total só pode vir do resumo oficial.
  out = out.split("\n").filter((line) => !(/\btotal\b/i.test(line) && /R\$/.test(line))).join("\n");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function firstNameOf(state: ConversationState, p: AtendenteParams, catalog: Catalog | null): string {
  const raw = clean(state.name || catalog?.customer?.name || p.customerName || "", 60).split(/\s+/)[0] || "";
  return /^[\p{L}][\p{L}'-]{1,30}$/u.test(raw) ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "";
}

// Mesma saudação de antes (a do botão "Ver cardápio"), agora só em texto com o link curto.
function greetingText(p: AtendenteParams, catalog: Catalog): string {
  const hello = p.periodGreeting() + "! 👋 Seja bem-vindo a *" + catalog.storeName + "*";
  const s = catalog.store;
  if (!s.isOpen) {
    return hello + "\n\n> No momento estamos fechados" + (s.opensAt ? " — abrimos " + s.opensAt : "") + ".\nNosso cardápio:\n👉 " + catalog.menuUrl;
  }
  return hello + "\n\n> Confira nosso cardápio e faça seu pedido por aqui. 😊\nÉ só clicar no link abaixo para ver o cardápio!\n👉 " + catalog.menuUrl +
    (p.sessionId === FATIMA_TENANT_ID ? "\n\nSe preferir falar com a loja, é só responder *atendente*." : "");
}

function fallbackText(catalog: Catalog | null, hasCart: boolean): string {
  return "Desculpe, estou com uma instabilidade agora 😅" + (hasCart ? " Seu pedido continua salvo aqui." : "") +
    " Me manda a mensagem de novo em instantes" + (catalog?.menuUrl ? " ou, se preferir, peça pelo cardápio: " + catalog.menuUrl : ".");
}

const pushHistory = (state: ConversationState, role: "user" | "model", text: string) => {
  state.history.push({ role, text: clean(text, 1500) });
  if (state.history.length > 14) state.history.splice(0, state.history.length - 14);
};

// ---------------------------------------------------------------------------
// Pedido já feito: contexto, "adicionar nele" e "cancelar qual?"
const CONTEXT_FRESH_MS = 30 * 60_000;
const RECENT_ORDER_MS = 3 * 3600_000;

function describeItemPlain(item: CartItem): string {
  const opts = item.options.map((o) => (o.quantity > 1 ? o.quantity + "x " : "") + o.name).join(", ");
  return item.quantity + "x " + item.name + (opts ? " (" + opts + ")" : "") + (item.notes ? " - obs: " + item.notes : "");
}

function paymentHint(text: string): string {
  const t = norm(text);
  if (/\bpix\b/.test(t)) return "Pix";
  if (/\bdebito\b/.test(t)) return "cartão de débito";
  if (/\bcredito\b/.test(t)) return "cartão de crédito";
  if (/\b(dinheiro|especie)\b/.test(t)) return "dinheiro";
  return "";
}

function addToPlacedText(orderNumber: string, items: string[], payment = ""): string {
  return "Quero adicionar no meu pedido" + (orderNumber ? " Nº " + orderNumber : " que acabei de fazer") + ": " + items.join("; ") +
    (payment ? ". Vou pagar o adicional no " + payment : "") + ".";
}

/** Número do pedido já feito de que se falou há pouco ("" = existe, número desconhecido; null = nenhum). */
function recentPlacedOrder(state: ConversationState, catalog: Catalog | null): string | null {
  const now = Date.now();
  if (state.placedContext && now - state.placedContext.at < RECENT_ORDER_MS) return state.placedContext.orderNumber;
  if (state.lastPlaced && now - state.lastPlaced.at < RECENT_ORDER_MS) return state.lastPlaced.orderNumber;
  const last = Date.parse(String(catalog?.customer?.lastOrderAt || ""));
  if (Number.isFinite(last) && now - last < RECENT_ORDER_MS) return "";
  return null;
}

function contextIsFresh(state: ConversationState): boolean {
  const now = Date.now();
  return Boolean((state.placedContext && now - state.placedContext.at < CONTEXT_FRESH_MS) ||
    (state.lastPlaced && now - state.lastPlaced.at < CONTEXT_FRESH_MS));
}

// Avisos de pedido enviados pela loja (/send: "pedido N° 2248 está em produção"):
// a próxima mensagem do cliente provavelmente fala desse pedido.
const outboundNotices = new Map<string, { orderNumber: string; at: number }>();
const phoneTail = (phone: string) => String(phone || "").replace(/\D/g, "").slice(-8);

export function noteOutboundOrderMessage(sessionId: string, phone: string, text: string) {
  if (!isAtendenteTenant(sessionId)) return;
  const number = (String(text || "").match(/\b(?:pedido|n[°ºo.]|#)\s*(?:n[°ºo.]\s*)?\*?#?\s*(\d{3,6})\b/i) || [])[1];
  const tail = phoneTail(phone);
  if (!number || tail.length < 8) return;
  outboundNotices.set(sessionId + "|" + tail, { orderNumber: number, at: Date.now() });
  if (outboundNotices.size > 5000) outboundNotices.delete(outboundNotices.keys().next().value as string);
}

/** Mensagem que só pergunta (tem X? / e X? / quanto custa X?), sem pedir. */
function isOnlyQuestion(text: string): boolean {
  const t = norm(text);
  if (/\b(quero|queria|vou querer|me (?:ve|manda|traz|da)|manda|pode (?:mandar|colocar|por|adicionar)|adiciona|coloca|bota|pedir|vou levar|separa)\b/.test(t)) return false;
  return /\?\s*$/.test(text.trim()) || /^(?:tem|voces tem|vcs tem|ainda tem|quanto (?:custa|e|fica|ta)|qual o (?:valor|preco))\b/.test(t);
}

const GENERIC_WORDS = new Set(["pedido", "lanche", "lanches", "porcao", "bebida", "pizza", "media", "grande", "pequena", "com", "sem", "tradicional"]);
/** O texto cita um item que está no carrinho ("cancela a coca" com Coca cola 2L no carrinho). */
function mentionsCartItem(state: ConversationState, text: string): boolean {
  const words = new Set(norm(text).replace(/[^a-z0-9 ]/g, " ").split(" ").filter(Boolean));
  return state.items.some((item) => norm(item.name).replace(/[^a-z0-9 ]/g, " ").split(" ")
    .some((w) => w.length >= 3 && !GENERIC_WORDS.has(w) && words.has(w)));
}

// ---------------------------------------------------------------------------
// Link de endereço (entrega iFood): clickaipedidos.com.br/e/<código>.
const LINK_TTL_MS = 60 * 60_000;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
type SavedAddress = NonNullable<NonNullable<Catalog["customer"]>["savedAddress"]>;
const addressLinks = new Map<string, { sessionId: string; customerJid: string; phone: string; name: string; at: number; saved: SavedAddress | null }>();

function ifoodQuoteExpired(state: ConversationState): boolean {
  const q = state.delivery?.type === "delivery" ? state.delivery.ifood : undefined;
  return Boolean(q && !(Date.parse(q.expiresAt) > Date.now() + 30_000));
}

function createAddressLink(p: AtendenteParams, state: ConversationState, catalog?: Catalog | null): string {
  let id = "";
  for (let i = 0; i < 10; i += 1) id += B62[randomInt(62)];
  if (state.addressLinkId) addressLinks.delete(state.addressLinkId);
  state.addressLinkId = id;
  const last = state.delivery?.type === "delivery" ? state.delivery : null;
  const saved: SavedAddress | null = last?.address
    ? { address: last.address, number: last.number, neighborhood: last.neighborhood, complement: last.complement, reference: last.reference, city: last.city, state: last.state, cep: last.cep }
    : catalog?.customer?.savedAddress || null;
  state.delivery = null;
  state.ifoodPayment = null;
  addressLinks.set(id, { sessionId: p.sessionId, customerJid: p.customerJid, phone: p.customerPhone || "", name: state.name, at: Date.now(), saved });
  return "clickaipedidos.com.br/e/" + id;
}

/** Dados do link para a página de endereço (consultado pelo servidor do site, com chave). */
export function getAddressLink(id: string) {
  const link = addressLinks.get(id);
  if (!link || Date.now() - link.at > LINK_TTL_MS) return null;
  return { sessionId: link.sessionId, phone: link.phone, customerName: link.name, savedAddress: link.saved };
}

type LinkAddress = { streetName: string; streetNumber: string; neighborhood: string; city: string; state: string; postalCode: string; complement?: string; reference?: string };

/** O cliente confirmou o endereço no link: grava a entrega com a cotação iFood e devolve o texto para continuar a conversa. */
export async function applyAddressFromLink(id: string, body: any):
  Promise<{ ok: true; sessionId: string; customerJid: string; phone: string; text: string; reply?: string } | { ok: false; status: number; error: string }> {
  const link = addressLinks.get(id);
  if (!link || Date.now() - link.at > LINK_TTL_MS) return { ok: false, status: 404, error: "Este link expirou. Peça um novo no WhatsApp." };
  const quote = body?.quote, a: LinkAddress = body?.address || {};
  const fee = Number(quote?.feeCents) / 100;
  if (!/^[0-9a-f-]{36}$/i.test(String(quote?.id || "")) || !Number.isFinite(fee) || fee < 0 || !a.streetName || !a.streetNumber || !a.neighborhood) {
    return { ok: false, status: 400, error: "Cotação inválida." };
  }
  const session = findSessionByAddressLink(id)?.session || (await getSession(link.sessionId, link.customerJid));
  const state = session.state;
  if (state.addressLinkId !== id) return { ok: false, status: 409, error: "Este link foi substituído por um mais novo no WhatsApp." };
  const payments: IfoodPaymentOption[] = (Array.isArray(quote.paymentMethods) ? quote.paymentMethods : [])
    .filter((m: any) => ["CREDIT", "DEBIT", "CASH"].includes(m?.method) && (m.method === "CASH" || (typeof m.brand === "string" && m.brand.trim())))
    .map((m: any) => (m.method === "CASH" ? { method: "CASH" } : { method: m.method, brand: String(m.brand).trim() }));
  state.delivery = {
    type: "delivery", address: clean(a.streetName, 120), number: clean(a.streetNumber, 30), neighborhood: clean(a.neighborhood, 100),
    complement: clean(a.complement || "", 160), reference: clean(a.reference || "", 160),
    city: clean(a.city, 80), state: clean(a.state, 2), cep: clean(a.postalCode, 9),
    ifood: { quoteId: String(quote.id), fee, expiresAt: String(quote.expiresAt || ""), payments },
  };
  state.addressLinkId = null;
  state.summary = null;
  state.awaitingConfirm = false;
  addressLinks.delete(id);
  // Pagamento escolhido antes do endereço: confere com o que o entregador aceita aqui.
  const catalog = session.catalog || null;
  if (state.payment && !state.payment.startsWith("online_") && checkIfoodPayment(state, state.payment, state.ifoodPayment?.brand, catalog)) {
    state.payment = "";
    state.ifoodPayment = null;
  }
  state.updatedAt = Date.now();
  void persist(link.sessionId);
  const where = state.delivery.address + ", " + state.delivery.number + " - " + state.delivery.neighborhood;
  const text = "[Endereço confirmado pelo cliente no link: " + where + ". Taxa de entrega iFood: " + brl(fee) +
    ". O entregador aceita na entrega: " + (ifoodPaymentsText(payments) || "nenhuma forma (só pagamento online)") +
    ". Avise que o endereço chegou com a taxa e continue o pedido: se faltar algo, pergunte; se estiver tudo certo, gere o resumo.]";
  // Sem pagamento ainda: a resposta sai pronta do código, só com as formas disponíveis agora.
  if (!state.payment) {
    const lines = ifoodPaymentLines(state, catalog);
    const reply = "✅ Endereço confirmado!\n📍 " + where + (state.delivery.complement ? " (" + state.delivery.complement + ")" : "") +
      "\n🛵 Taxa de entrega (iFood): " + brl(fee) + "\n\n" +
      (lines.length ? "Como prefere pagar? Formas disponíveis agora:\n" + lines.join("\n")
        : "No momento o entregador do iFood não está aceitando pagamento na entrega para este endereço 😕 Se preferir, pode retirar na loja.");
    pushHistory(state, "user", "(confirmei o endereço pelo link)");
    pushHistory(state, "model", reply);
    void persist(link.sessionId);
    return { ok: true, sessionId: link.sessionId, customerJid: link.customerJid, phone: link.phone, text, reply };
  }
  return { ok: true, sessionId: link.sessionId, customerJid: link.customerJid, phone: link.phone, text };
}

const orderLabel = (n: string) => "pedido" + (n ? " Nº " + n : " que você já fez");
const numberIn = (text: string) => (norm(text).match(/\b(\d{3,})\b/) || [])[1] || "";

function clearDraft(state: ConversationState) {
  Object.assign(state, freshState(), {
    name: state.name, lastPlaced: state.lastPlaced, history: state.history, greetedAt: state.greetedAt, placedContext: state.placedContext,
    lastReroute: state.lastReroute || null,
  });
}

/** Registra que a conversa tratou de um pedido já feito (ex.: "acompanhar pedido"). */
export async function noteOrderContext(sessionId: string, customerJid: string, orderNumber: string) {
  if (!isAtendenteTenant(sessionId)) return;
  const session = await getSession(sessionId, customerJid);
  session.state.placedContext = { orderNumber: clean(orderNumber, 30), at: Date.now() };
  session.state.updatedAt = Date.now();
  await persist(sessionId);
}

/** Decisões sobre pedido já feito antes da IA. Retorna texto para o fluxo de pedidos feitos, true se respondeu, false se segue. */
async function placedOrderRouting(state: ConversationState, catalog: Catalog, text: string, reply: (m: string) => Promise<void>): Promise<string | boolean> {
  const recent = recentPlacedOrder(state, catalog);
  const explicit = refersToPlacedOrder(text);

  // Resposta a "este carrinho ou o pedido Nº X?"
  const pending = state.pendingChoice;
  if (pending) {
    state.pendingChoice = null;
    if (Date.now() - pending.at < 10 * 60_000) {
      const answer = choiceAnswer(text);
      if (pending.kind === "cancel" && answer === "draft") {
        clearDraft(state);
        await reply("Pronto, cancelei o pedido que estávamos montando 👍" + (pending.orderNumber ? " O pedido Nº " + pending.orderNumber + " continua normal." : ""));
        return true;
      }
      if (pending.kind === "cancel" && answer === "placed") {
        return "Quero cancelar o meu pedido" + (pending.orderNumber ? " Nº " + pending.orderNumber : "");
      }
      if (pending.kind === "add" && answer === "placed") {
        state.addToPlaced = { orderNumber: pending.orderNumber, at: Date.now(), payment: paymentHint(pending.text) };
        return "use:" + pending.text;
      }
      if (pending.kind === "add" && answer === "draft") return "use:" + pending.text;
    }
  }

  // Item do carrinho que deve ir para o pedido já feito ("quero adicionar ela no pedido que acabei de fazer").
  if (state.items.length && explicit && (wantsToAdd(text) || /\b(ela|ele|isso|essa|esse|tambem|junto)\b/.test(norm(text)))) {
    const orderNumber = numberIn(text) || recent || "";
    const items = state.items.map(describeItemPlain);
    const payment = paymentHint(text) || paymentHint(state.history.filter((t) => t.role === "user").slice(-4).map((t) => t.text).join(" "));
    const itemsKey = norm(items.join("; "));
    const already = state.lastReroute && state.lastReroute.items === itemsKey && Date.now() - state.lastReroute.at < 15 * 60_000;
    clearDraft(state);
    state.placedContext = { orderNumber, at: Date.now() };
    if (already) {
      await reply("Esse item (" + items.join(", ") + ") já foi enviado para a loja acrescentar no seu " + orderLabel(orderNumber) + " ✅ Não vou mandar de novo. " +
        "Assim que a loja responder, te aviso por aqui. Se quiser *mais uma unidade além dessa*, é só me dizer.");
      return true;
    }
    state.lastReroute = { items: itemsKey, at: Date.now() };
    return addToPlacedText(orderNumber, items, payment);
  }

  // Cancelar: carrinho atual, pedido já feito ou perguntar qual.
  // "cancela a coca" / "não quero mais a batata" é tirar um item do carrinho, não cancelar tudo.
  if (wantsToCancel(text) && !wantsToAdd(text) && !(state.items.length > 1 && mentionsCartItem(state, text))) {
    if (!state.items.length) return recent !== null || explicit ? text : false;
    if (explicit) return text;
    if (recent !== null) {
      state.pendingChoice = { kind: "cancel", text, orderNumber: recent, at: Date.now() };
      await reply("Quer cancelar *este pedido que estamos montando* (" + state.items.map(describeItemPlain).join(", ") + ") ou o *" + orderLabel(recent) + "*?");
      return true;
    }
    clearDraft(state);
    await reply("Pronto, cancelei o pedido que estávamos montando 👍 Se quiser começar de novo, é só me dizer.");
    return true;
  }

  // "Quero adicionar..." sem carrinho e com pedido recente: é para o pedido já feito?
  if (!state.items.length && !state.addToPlaced && wantsToAdd(text) && !wantsPaymentChange(text) && recent !== null) {
    if (explicit || contextIsFresh(state)) {
      state.addToPlaced = { orderNumber: numberIn(text) || recent, at: Date.now(), payment: paymentHint(text) };
      return false;
    }
    state.pendingChoice = { kind: "add", text, orderNumber: recent, at: Date.now() };
    await reply("Você quer adicionar no *" + orderLabel(recent) + "* ou fazer um *pedido novo*?");
    return true;
  }
  return false;
}

async function processTurn(p: AtendenteParams, session: Session, text: string): Promise<string | void> {
  const state = session.state;
  state.updatedAt = Date.now();
  const catalog = await ensureCatalog(session, p);
  const reply = async (message: string) => {
    pushHistory(state, "model", message);
    await p.sendMessage(message);
  };
  pushHistory(state, "user", text);
  if (!catalog) { await reply(fallbackText(null, state.items.length > 0)); return; }
  if (!state.name) {
    state.name = clean(catalog.customer?.name || p.customerName || "", 80).replace(/[^\p{L}\p{M}' .-]/gu, "").trim();
    state.nameSource = catalog.customer?.name ? "profile" : "whatsapp";
  }
  const firstName = firstNameOf(state, p, catalog);

  // 1) Atendente humano: pausa este cliente.
  if (wantsHuman(text)) {
    await p.pauseForHuman();
    await reply("Certo! Já chamei alguém da loja para falar com você. Aguarde só um pouquinho 🙏" + (state.items.length ? "\nSeu pedido em montagem fica guardado." : ""));
    return;
  }

  // 1b) Pedido já feito: adicionar nele, cancelar qual, mover item do carrinho.
  if (state.addToPlaced && Date.now() - state.addToPlaced.at > CONTEXT_FRESH_MS) state.addToPlaced = null;
  const routed = await placedOrderRouting(state, catalog, text, reply);
  if (routed === true) return;
  if (typeof routed === "string") {
    if (!routed.startsWith("use:")) {
      state.placedContext = { orderNumber: state.placedContext?.orderNumber || "", at: Date.now() };
      pushHistory(state, "model", "(Encaminhei para a loja, sobre o pedido já feito: " + routed + ")");
      return routed;
    }
    text = routed.slice(4);
  }

  // 2) "sim" para o resumo: decisão do código, nunca da IA.
  const lastBot = [...state.history].reverse().find((t) => t.role === "model")?.text || "";
  const askedToConfirm = state.awaitingConfirm || /posso confirmar|confirmar o (?:seu )?pedido/i.test(lastBot);
  if (askedToConfirm && state.summary && isPureYes(text)) {
    if (!summaryIsCurrent(state)) {
      const again = await makeSummary(p.sessionId, String(p.customerPhone), state);
      if (again.ok && again.text) { state.awaitingConfirm = true; await reply("O pedido mudou, então atualizei o resumo:\n\n" + again.text); return; }
      state.awaitingConfirm = false;
      await reply(again.erro === "sistema_indisponivel" ? fallbackText(catalog, true) : "Não consegui conferir o pedido: " + (again.motivo || "faltam dados") + ".");
      return;
    }
    if (ifoodQuoteExpired(state)) {
      state.awaitingConfirm = false;
      state.summary = null;
      await reply("A taxa de entrega do iFood vale por pouco tempo e acabou de vencer 😕 Confirma o endereço de novo neste link que eu atualizo o resumo:\n" + createAddressLink(p, state, catalog));
      return;
    }
    const result = await commitOrder(p.sessionId, String(p.customerPhone), state, catalog);
    state.awaitingConfirm = result.kind === "changed";
    if (result.kind === "placed") p.logger.info({ sessionId: p.sessionId }, "[Atendente] Pedido gravado");
    if (result.kind === "placed" || result.kind === "changed") { await reply(result.text); return; }
    if (result.kind === "unavailable") {
      state.awaitingConfirm = true;
      await reply("Não consegui enviar o pedido agora por uma instabilidade 😕 Ele continua salvo. Pode responder *sim* de novo em instantes" + (catalog.menuUrl ? " ou pedir pelo cardápio: " + catalog.menuUrl : "."));
      return;
    }
    await reply("Não consegui confirmar: " + result.reason + "\nMe diga como prefere ajustar que eu refaço o resumo.");
    return;
  }

  // 3) "sim" repetido logo após um pedido gravado: nunca grava de novo.
  if (!state.items.length && state.lastPlaced && Date.now() - state.lastPlaced.at < 30 * 60_000 && isPureYes(text)) {
    await reply("Seu pedido *Nº " + state.lastPlaced.orderNumber + "* já foi enviado para a loja ✅ Para acompanhar, mande *acompanhar pedido*.");
    return;
  }

  // 4) Saudação simples: resposta pronta (rápida e sem custo de IA).
  if (isOnlyGreeting(text) && !state.items.length) {
    state.greetedAt = Date.now();
    await reply(greetingText(p, catalog));
    return;
  }

  // 5) Conversa livre com o Gemini + ferramentas.
  const flags: TurnFlags = {};
  const itemsBefore = state.items.length;
  const contents: GeminiContent[] = state.history.slice(0, -1).slice(-10).map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
  while (contents.length && contents[0].role !== "user") contents.shift();
  contents.push({ role: "user", parts: [{ text }] });
  let answer = "";
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const parts = await generate(systemPrompt(state, catalog, firstName), contents, TOOLS);
      const calls = parts.filter((part) => part.functionCall);
      const texts = parts.filter((part) => typeof part.text === "string" && !part.thought).map((part) => String(part.text)).join("\n").trim();
      if (!calls.length) { answer = texts; break; }
      contents.push({ role: "model", parts });
      const responses: GeminiPart[] = [];
      for (const part of calls) {
        const call = part.functionCall!;
        const result = await runTool(call.name, call.args || {}, { p, state, catalog, flags });
        p.logger.info({ sessionId: p.sessionId, tool: call.name, ok: !("erro" in result) }, "[Atendente] Ferramenta");
        responses.push({ functionResponse: { name: call.name, response: result } });
      }
      if (flags.summary || flags.handoff || flags.reroute) { answer = texts; break; }
      contents.push({ role: "user", parts: responses });
    }
  } catch (error: any) {
    if (!(error instanceof GeminiUnavailable)) throw error;
    p.logger.warn({ sessionId: p.sessionId, reason: error.message }, "[Atendente] Gemini indisponível; resposta de contingência");
    state.awaitingConfirm = Boolean(state.summary && summaryIsCurrent(state));
    await reply(fallbackText(catalog, state.items.length > 0));
    return;
  }

  if (flags.reroute) {
    state.addToPlaced = null;
    pushHistory(state, "model", "(Encaminhei para a loja, sobre o pedido já feito: " + flags.reroute + ")");
    return flags.reroute;
  }
  if (flags.handoff && !wantsHuman(text) && !/\b(pessoa|alguem|humano|dono|dona|gerente|reclam\w*|falar com)\b/.test(norm(text))) {
    flags.handoff = false;
    if (!answer.trim()) answer = "Me conta o que você precisa que eu resolvo por aqui 😊 Se preferir falar com alguém da loja, é só escrever *atendente*.";
  }
  if (flags.handoff) {
    await p.pauseForHuman();
    await reply("Certo! Já chamei alguém da loja para falar com você. Aguarde só um pouquinho 🙏");
    return;
  }
  let lead = sanitizeReply(answer, catalog);
  // "Adicionei mais um..." com o carrinho vazio antes deste turno: tira o "mais".
  if (itemsBefore === 0) lead = lead.replace(/\b(adicionei|coloquei|anotei|separei)\s+mais\s+(?=(?:um|uma|\d+)\b)/gi, "$1 ");
  if (flags.summary) {
    state.awaitingConfirm = true;
    // Texto da IA antes do resumo sem perguntas soltas (a pergunta final é a confirmação).
    const intro = lead.split("\n").filter((line) => !/\?\s*$/.test(line.trim())).join("\n").trim();
    await reply((intro ? intro + "\n\n" : "") + flags.summary);
    return;
  }
  state.awaitingConfirm = Boolean(state.summary && summaryIsCurrent(state) && /posso confirmar/i.test(lead));
  await reply(lead || (state.items.length ? "Anotado! Quer mais alguma coisa?" : "Pode me dizer o que você gostaria de pedir? 😊 Cardápio: " + catalog.menuUrl));
}

// ---------------------------------------------------------------------------
// Fila por cliente: mensagens seguidas são juntadas (ritmo humano, menos respostas).
type Pending = { texts: string[]; timer?: ReturnType<typeof setTimeout>; done: Promise<void>; resolve: () => void; params: AtendenteParams; reroute?: string };
const pending = new Map<string, Pending>();
const chains = new Map<string, Promise<void>>();

function editsPlacedOrder(text: string) {
  return /\b(tira\w*|retir\w*|remov\w*|troc\w*|mud\w*|alter\w*)\b/.test(norm(text));
}

/** true = o atendente novo cuidou; false = segue o fluxo atual; texto = segue o fluxo atual com este texto. */
export async function handleAtendenteMessage(p: AtendenteParams): Promise<boolean | string> {
  if (!isAtendenteTenant(p.sessionId) || !backendConfigured() || !p.customerPhone || !p.text.trim()) return false;
  if (p.legacyBusy) return false;
  const key = p.sessionId + "|" + p.customerJid;
  const session = await getSession(p.sessionId, p.customerJid);
  const state = session.state;
  // Pedido já feito (acompanhar, alterar, cancelar): atendimento atual de pedidos.
  const markPlaced = () => {
    state.placedContext = { orderNumber: numberIn(p.text) || state.placedContext?.orderNumber || state.lastPlaced?.orderNumber || "", at: Date.now() };
    state.updatedAt = Date.now();
    void persist(p.sessionId);
  };
  // Aviso de pedido enviado pela loja há pouco: a conversa passa a ser sobre esse pedido.
  const notice = outboundNotices.get(p.sessionId + "|" + phoneTail(p.customerPhone));
  if (notice && Date.now() - notice.at < CONTEXT_FRESH_MS && (!state.placedContext || state.placedContext.at < notice.at)) {
    state.placedContext = { orderNumber: notice.orderNumber, at: notice.at };
  }
  // Trocar pagamento de pedido já feito: nunca vira pedido novo (antes gerava pedido duplicado).
  if (!state.items.length && !state.pendingChoice && wantsPaymentChange(p.text) &&
    recentPlacedOrder(state, session.catalog || null) !== null) {
    const number = (norm(p.text).match(/(?:pedido|n[°ºo.]|#)\s*(?:n[°ºo.]\s*)?#?\s*(\d{3,6})\b/) || [])[1] || recentPlacedOrder(state, session.catalog || null) || "";
    markPlaced();
    return "Quero trocar a forma de pagamento do meu pedido" + (number ? " Nº " + number : "") + ": " + clean(p.text, 300);
  }
  // Só o número do pedido ("2248") logo depois de falar de um pedido feito: é sobre ele.
  if (!state.items.length && !state.pendingChoice && isOrderNumberOnly(p.text) && recentPlacedOrder(state, session.catalog || null) !== null) {
    markPlaced(); return false;
  }
  if (!state.items.length && !state.pendingChoice && aboutPlacedOrder(p.text) && !wantsToAdd(p.text)) { markPlaced(); return false; }
  if (!state.items.length && !state.pendingChoice && recentPlacedOrder(state, session.catalog || null) !== null &&
    editsPlacedOrder(p.text) && !wantsToAdd(p.text)) { markPlaced(); return false; }
  // Sem cardápio (loja não liberada na Vercel ou fora do ar e sem cache): fluxo atual.
  if (!(await ensureCatalog(session, p))) return false;

  let entry = pending.get(key);
  if (!entry) {
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    entry = { texts: [], done, resolve, params: p };
    pending.set(key, entry);
  }
  entry.texts.push(clean(p.text, 1500));
  entry.params = p;
  if (entry.timer) clearTimeout(entry.timer);
  const current = entry;
  current.timer = setTimeout(() => {
    pending.delete(key);
    const run = (chains.get(key) || Promise.resolve()).then(async () => {
      try {
        const reroute = await processTurn(current.params, session, current.texts.join("\n"));
        if (reroute) current.reroute = reroute;
      } catch (error: any) {
        current.params.logger.warn({ sessionId: p.sessionId, error: error?.message }, "[Atendente] Falha inesperada");
        await current.params.sendMessage(fallbackText(session.catalog || null, session.state.items.length > 0)).catch(() => undefined);
      } finally {
        await persist(p.sessionId);
      }
    });
    chains.set(key, run);
    void run.finally(() => { if (chains.get(key) === run) chains.delete(key); current.resolve(); });
  }, DEBOUNCE_MS);
  await current.done;
  // Só a última mensagem juntada leva o texto para o fluxo de pedidos já feitos.
  if (current.reroute) return current.params === p ? current.reroute : true;
  return true;
}
