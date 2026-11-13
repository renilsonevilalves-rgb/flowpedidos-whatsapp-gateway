// Atendente de pedidos pelo WhatsApp (conversa livre, sem botões e sem menu de números).
// O Gemini conversa e escolhe ferramentas; preço/taxa/total vêm do backend e a
// confirmação ("sim" para o resumo mais recente) é decidida pelo código.
import { chatOrder, backendConfigured } from "./backend.js";
import { describeProduct, searchProducts, soldOutMatch, type Catalog } from "./catalog.js";
import { generate, GeminiUnavailable, type GeminiContent, type GeminiPart } from "./gemini.js";
import {
  addItem, changeItem, commitOrder, describeCart, makeSummary, missingForSummary, PAYMENT_NAMES,
  removeItem, setDelivery, setName, setPayment, summaryIsCurrent, type ToolOutcome,
} from "./order.js";
import { freshState, getSession, persist, type ConversationState, type Session } from "./state.js";
import { aboutPlacedOrder, brl, clean, isOnlyGreeting, isPureYes, norm, wantsHuman } from "./text.js";

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
export function isAtendenteTenant(sessionId: string): boolean {
  return atendenteTenants().has(sessionId);
}

// ---------------------------------------------------------------------------
// Cardápio (cache de 5 min por cliente; o perfil do cliente vem junto)
async function ensureCatalog(session: Session, p: AtendenteParams): Promise<Catalog | null> {
  if (session.catalog && Date.now() - (session.catalogAt || 0) < CATALOG_TTL_MS) return session.catalog;
  const result = await chatOrder({ action: "catalog", sessionId: p.sessionId, phone: p.customerPhone || "" });
  if (result.ok && Array.isArray(result.data?.products) && result.data?.store) {
    const d = result.data;
    session.catalog = {
      storeName: clean(d.storeName, 120), menuUrl: clean(d.menuUrl, 300), products: d.products,
      soldOut: Array.isArray(d.soldOut) ? d.soldOut : [], store: d.store, customer: d.customer || null,
      learnedAliases: Array.isArray(d.learnedAliases) ? d.learnedAliases : [],
    };
    session.catalogAt = Date.now();
    return session.catalog;
  }
  p.logger.warn({ sessionId: p.sessionId, status: result.status }, "[Atendente] Catálogo indisponível");
  return session.catalog || null;
}

// ---------------------------------------------------------------------------
// Ferramentas do Gemini
const S = (description: string) => ({ type: "STRING", description });
const TOOLS = [
  { name: "buscar_cardapio", description: "Busca produtos reais do cardápio (aceita erros de digitação e apelidos). Use antes de falar de qualquer produto, sabor, tamanho, borda, adicional ou preço.",
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
  { name: "definir_entrega", description: "Define entrega (com endereço) ou retirada. Use usar_endereco_salvo=true quando o cliente aceitar o endereço do último pedido.",
    parameters: { type: "OBJECT", properties: {
      tipo: S("'entrega' ou 'retirada'"), usar_endereco_salvo: { type: "BOOLEAN", description: "usar o endereço do último pedido" },
      rua: S("rua/avenida"), numero: S("número"), bairro: S("bairro"), complemento: S("apto, bloco, casa"), referencia: S("ponto de referência"),
    }, required: ["tipo"] } },
  { name: "definir_pagamento", description: "Define a forma de pagamento (pix, credito, debito, dinheiro ou online). Para dinheiro, informe troco_para ou sem_troco.",
    parameters: { type: "OBJECT", properties: { forma: S("pix | credito | debito | dinheiro | pix online | credito online | debito online"),
      troco_para: { type: "NUMBER", description: "valor em reais para o troco" }, sem_troco: { type: "BOOLEAN", description: "true se não precisa de troco" } }, required: ["forma"] } },
  { name: "definir_nome", description: "Define o nome do cliente para o pedido.",
    parameters: { type: "OBJECT", properties: { nome: S("nome do cliente") }, required: ["nome"] } },
  { name: "gerar_resumo", description: "Calcula os valores oficiais (subtotal, taxa, total) e envia o resumo ao cliente pedindo confirmação. Chame quando itens, entrega/endereço, pagamento e nome estiverem definidos, e de novo sempre que algo mudar depois de um resumo.",
    parameters: { type: "OBJECT", properties: {} } },
  { name: "cancelar_rascunho", description: "Descarta o pedido em montagem quando o cliente desistir.", parameters: { type: "OBJECT", properties: {} } },
  { name: "chamar_atendente", description: "Pausa o robô e chama uma pessoa da loja para este cliente.", parameters: { type: "OBJECT", properties: {} } },
];

type TurnFlags = { summary?: string; handoff?: boolean };

async function runTool(name: string, args: any, ctx: { p: AtendenteParams; state: ConversationState; catalog: Catalog; flags: TurnFlags }): Promise<ToolOutcome> {
  const { p, state, catalog } = ctx;
  switch (name) {
    case "buscar_cardapio": {
      const term = clean(args?.termo, 120);
      const found = searchProducts(catalog, term, 8);
      const sold = soldOutMatch(catalog, term);
      if (!found.length) return { resultados: [], ...(sold ? { esgotado: sold } : {}), dica: "Nada parecido no cardápio. Não invente." };
      return { resultados: found.map((m) => describeProduct(m.product)), ...(sold ? { esgotado: sold } : {}) };
    }
    case "adicionar_item": return addItem(state, catalog, args);
    case "remover_item": return removeItem(state, args);
    case "alterar_item": return changeItem(state, args);
    case "definir_entrega": return setDelivery(state, catalog, args);
    case "definir_pagamento": return setPayment(state, catalog, args);
    case "definir_nome": return setName(state, args);
    case "gerar_resumo": {
      if (!catalog.store.isOpen) return { erro: "loja_fechada", abre: catalog.store.opensAt };
      const result = await makeSummary(p.sessionId, String(p.customerPhone), state);
      if (result.ok && result.text) { ctx.flags.summary = result.text; return { ok: true, enviado: "O sistema enviou o resumo ao cliente. Não escreva valores." }; }
      return result;
    }
    case "cancelar_rascunho": {
      Object.assign(state, freshState(), { name: state.name, lastPlaced: state.lastPlaced, history: state.history, greetedAt: state.greetedAt });
      return { ok: true, carrinho: [] };
    }
    case "chamar_atendente": ctx.flags.handoff = true; return { ok: true };
    default: return { erro: "ferramenta_desconhecida" };
  }
}

// ---------------------------------------------------------------------------
function storeBlock(catalog: Catalog): string {
  const s = catalog.store;
  const lines = [
    "Loja: " + catalog.storeName,
    "Link do cardápio: " + catalog.menuUrl,
    s.isOpen ? "Situação: ABERTA agora" + (s.closesAt ? ", fecha às " + s.closesAt : "") : "Situação: FECHADA agora" + (s.opensAt ? "; abre " + s.opensAt : "") + ". Não monte pedido.",
    s.text ? "Horários: " + s.text : "",
    "Pagamentos aceitos: " + s.paymentMethods.map((m) => m.label).join(", "),
    s.minimumOrderValue ? "Pedido mínimo (produtos): " + brl(s.minimumOrderValue) : "",
    s.preparationTime ? "Tempo de preparo: " + s.preparationTime.min + "-" + s.preparationTime.max + " min" : "",
    s.deliveryMode === "neighborhood"
      ? (s.deliveryFees.length ? "Taxas de entrega por bairro: " + s.deliveryFees.map((f) => f.name + " " + brl(f.fee)).join("; ") : "Entrega: sem taxa cadastrada")
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
    "Nome do cliente: " + (state.name || "(não informado)") + (firstName ? " (chame de " + firstName + ")" : ""),
    saved?.address ? "Endereço do último pedido: " + saved.address + ", " + saved.number + " - " + saved.neighborhood + (saved.complement ? " (" + saved.complement + ")" : "") : "Sem endereço salvo",
    c?.lastOrder?.paymentMethod ? "Pagamento do último pedido: " + (PAYMENT_NAMES[c.lastOrder.paymentMethod] || c.lastOrder.paymentMethod) : "",
    "CARRINHO: " + (state.items.length ? "\n  " + describeCart(state).join("\n  ") : "vazio"),
    "Entrega: " + (!d ? "(não definida)" : d.type === "pickup" ? "retirada" : d.address + ", " + d.number + " - " + d.neighborhood),
    "Pagamento: " + (state.payment ? PAYMENT_NAMES[state.payment] : "(não definido)") + (state.payment === "money" ? (state.changeFor === null ? ", troco não perguntado" : state.changeFor ? ", troco para " + brl(state.changeFor) : ", sem troco") : ""),
    state.items.length ? "Ainda falta: " + (missingForSummary(state).join(", ") || "nada — pode chamar gerar_resumo") : "",
    state.summary ? (summaryIsCurrent(state) ? "Resumo já enviado e atual: aguardando o cliente confirmar." : "O pedido mudou depois do último resumo: chame gerar_resumo de novo.") : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function systemPrompt(state: ConversationState, catalog: Catalog, firstName: string): string {
  return [
    "Você é o atendente virtual de pedidos de um delivery no WhatsApp. Fale em português do Brasil, curto e simpático (no máximo 1 ou 2 emojis por mensagem). Nada de menus numerados, nada de botões.",
    "REGRAS:",
    "1. Nunca invente produto, sabor, tamanho, preço, taxa ou total. Use só o cardápio abaixo e as ferramentas. Na dúvida, chame buscar_cardapio.",
    "2. Quando o cliente disser o que quer, chame adicionar_item na hora (não pergunte 'posso adicionar?'). Diga o item e o preço em uma frase curta.",
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
    "",
    "LOJA:\n" + storeBlock(catalog),
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

function greetingText(p: AtendenteParams, catalog: Catalog, firstName: string): string {
  const hello = p.periodGreeting() + (firstName ? ", " + firstName : "") + "! 😊";
  const s = catalog.store;
  if (!s.isOpen) {
    return hello + " Aqui é da *" + catalog.storeName + "*.\nNo momento estamos fechados" + (s.opensAt ? " — abrimos " + s.opensAt : "") +
      ".\n\nO cardápio fica aqui: " + catalog.menuUrl;
  }
  const until = s.closesAt ? (s.closesAt === "00:00" || s.closesAt === "23:59" ? " até meia-noite" : " até as " + s.closesAt) : "";
  return hello + " Aqui é da *" + catalog.storeName + "*. Estamos abertos" + until + ".\n\n" +
    "Pode fazer seu pedido por aqui mesmo, é só me dizer o que deseja. Se preferir, o cardápio completo está aqui: " + catalog.menuUrl;
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
async function processTurn(p: AtendenteParams, session: Session, text: string): Promise<void> {
  const state = session.state;
  state.updatedAt = Date.now();
  const catalog = await ensureCatalog(session, p);
  const reply = async (message: string) => {
    pushHistory(state, "model", message);
    await p.sendMessage(message);
  };
  pushHistory(state, "user", text);
  if (!catalog) { await reply(fallbackText(null, state.items.length > 0)); return; }
  if (!state.name) state.name = clean(catalog.customer?.name || p.customerName || "", 80).replace(/[^\p{L}\p{M}' .-]/gu, "").trim();
  const firstName = firstNameOf(state, p, catalog);

  // 1) Atendente humano: pausa este cliente.
  if (wantsHuman(text)) {
    await p.pauseForHuman();
    await reply("Certo! Já chamei alguém da loja para falar com você. Aguarde só um pouquinho 🙏" + (state.items.length ? "\nSeu pedido em montagem fica guardado." : ""));
    return;
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
    await reply(greetingText(p, catalog, firstName));
    return;
  }

  // 5) Conversa livre com o Gemini + ferramentas.
  const flags: TurnFlags = {};
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
      if (flags.summary || flags.handoff) { answer = texts; break; }
      contents.push({ role: "user", parts: responses });
    }
  } catch (error: any) {
    if (!(error instanceof GeminiUnavailable)) throw error;
    p.logger.warn({ sessionId: p.sessionId, reason: error.message }, "[Atendente] Gemini indisponível; resposta de contingência");
    state.awaitingConfirm = Boolean(state.summary && summaryIsCurrent(state));
    await reply(fallbackText(catalog, state.items.length > 0));
    return;
  }

  if (flags.handoff) {
    await p.pauseForHuman();
    await reply("Certo! Já chamei alguém da loja para falar com você. Aguarde só um pouquinho 🙏");
    return;
  }
  const lead = sanitizeReply(answer, catalog);
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
type Pending = { texts: string[]; timer?: ReturnType<typeof setTimeout>; done: Promise<void>; resolve: () => void; params: AtendenteParams };
const pending = new Map<string, Pending>();
const chains = new Map<string, Promise<void>>();

function editsPlacedOrder(text: string) {
  return /\b(adiciona|acrescenta|coloca|inclui|esqueci|faltou|tira|retira|remove|troca|trocar|muda|mudar)\b/.test(norm(text));
}

/** true = o atendente novo cuidou da mensagem; false = segue o fluxo atual. */
export async function handleAtendenteMessage(p: AtendenteParams): Promise<boolean> {
  if (!isAtendenteTenant(p.sessionId) || !backendConfigured() || !p.customerPhone || !p.text.trim()) return false;
  if (p.legacyBusy) return false;
  const key = p.sessionId + "|" + p.customerJid;
  const session = await getSession(p.sessionId, p.customerJid);
  const state = session.state;
  // Pedido já feito (acompanhar, alterar, cancelar): atendimento atual de pedidos.
  if (!state.items.length && aboutPlacedOrder(p.text)) return false;
  if (!state.items.length && state.lastPlaced && Date.now() - state.lastPlaced.at < 2 * 3600_000 && editsPlacedOrder(p.text)) return false;
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
        await processTurn(current.params, session, current.texts.join("\n"));
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
  return true;
}
