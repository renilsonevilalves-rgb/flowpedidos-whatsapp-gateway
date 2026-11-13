// Atendente de pedidos pela conversa (src/atendente). Conversas completas com
// Gemini simulado e backend (Vercel) simulado. Nada sai da máquina.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

const SID = "11848b07-bcdc-4fef-9db3-701b5e7d4c10";
process.env.WHATSAPP_AI_ORDER_TENANTS = SID;
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "k";
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.GEMINI_FALLBACK_MODEL = "";
process.env.ATENDENTE_DEBOUNCE_MS = "0";
process.env.ATENDENTE_STATE_DIR = tmpdir() + "/atendente-test-" + process.pid;

const { handleAtendenteMessage, noteOrderContext, noteOutboundOrderMessage, applyAddressFromLink, getAddressLink } = await import("../dist/atendente/engine.js");
const { resetStateForTests } = await import("../dist/atendente/state.js");
const { searchProducts, resolveProduct, resolveOption } = await import("../dist/atendente/catalog.js");
const { isPureYes, wantsPaymentChange, isOrderNumberOnly } = await import("../dist/atendente/text.js");

// ---------------------------------------------------------------- cardápio
const sabores = { id: "g-sab", name: "Sabores", min: 1, max: 2, options: [
  { id: "o-cal", name: "Calabresa", price: 0 }, { id: "o-fcat", name: "Frango com Catupiry", price: 0 },
  { id: "o-ccb", name: "Calabresa com Cheddar e Bacon", price: 5 }, { id: "o-por", name: "Portuguesa", price: 0 }] };
const borda = { id: "g-bor", name: "Borda", min: 0, max: 1, options: [
  { id: "o-bcat", name: "Catupiry", price: 8 }, { id: "o-bche", name: "Cheddar", price: 8 }] };
const PRODUCTS = [
  { id: "p-med", name: "Pizza Média", category: "Pizzas", price: 45, description: "6 pedaços, até 2 sabores", optionGroups: [sabores, borda] },
  { id: "p-gra", name: "Pizza Grande", category: "Pizzas", price: 60, description: "8 pedaços, até 2 sabores", optionGroups: [sabores, borda] },
  { id: "c-2l", name: "Coca cola 2L", category: "Bebidas", price: 17.99 },
  { id: "c-350", name: "Coca cola 350ml", category: "Bebidas", price: 6 },
  { id: "x-tud", name: "X- Tudo Turbo", category: "Lanches", price: 34.9, optionGroups: [{ id: "g-rec", name: "Escolha o Recheio", min: 0, max: 3, options: [
    { id: "o-ched", name: "cheddar", price: 1 }, { id: "o-catu", name: "catupiry", price: 2 }] }] },
  { id: "x-sal", name: "X- Salada", category: "Lanches", price: 22 },
];
const STORE = { isOpen: true, closesAt: "23:00", opensAt: null, text: "", deliveryMode: "neighborhood",
  deliveryFees: [{ name: "Centro", fee: 4.99 }, { name: "Santa Helena", fee: 2.5 }], minimumOrderValue: 0,
  preparationTime: { min: 15, max: 20 }, address: "Rua da Loja, 1",
  paymentMethods: [{ id: "pix", label: "Pix" }, { id: "credit", label: "cartão de crédito" }, { id: "debit", label: "cartão de débito" }, { id: "money", label: "dinheiro" }] };
const CUSTOMER = { name: "Renilson Alves", lastOrder: { paymentMethod: "credit", deliveryType: "delivery" },
  savedAddress: { address: "Rua das Flores", number: "123", neighborhood: "Centro", complement: "", reference: "" } };
const CATALOG = { storeName: "Click Testes", menuUrl: "https://clickaipedidos.com.br/cardapio/click-testes",
  products: PRODUCTS, soldOut: [{ id: "s-pud", name: "Pudim" }], store: STORE, customer: CUSTOMER, learnedAliases: [] };

// ---------------------------------------------------------------- backend simulado
let world;
function resetWorld() {
  resetStateForTests();
  world = { store: { ...STORE }, customer: CUSTOMER, commits: [], previews: [], placed: new Map(), commitFailOnce: false,
    geminiCalls: 0, geminiDown: false, script: [], geminiBodies: [] };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function price(body) {
  let subtotal = 0; const items = [];
  for (const it of body.items) {
    const p = PRODUCTS.find((x) => x.id === it.productId);
    const opts = it.selectedOptions.map((o) => { const all = (p.optionGroups || []).flatMap((g) => g.options); const f = all.find((a) => a.id === o.id); return { ...f, quantity: o.quantity }; });
    const unit = Math.round((p.price + opts.reduce((s, o) => s + o.price * o.quantity, 0)) * 100) / 100;
    const total = Math.round(unit * it.quantity * 100) / 100;
    subtotal = Math.round((subtotal + total) * 100) / 100;
    items.push({ name: p.name, quantity: it.quantity, total, selectedOptions: opts, notes: it.notes });
  }
  const fee = body.ifoodQuoteId ? 7.5 : body.deliveryType === "delivery" ? (world.store.deliveryFees.find((f) => f.name === body.neighborhood)?.fee ?? 0) : 0;
  return { items, subtotal, deliveryFee: fee, total: Math.round((subtotal + fee) * 100) / 100 };
}
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(init.body) : {};
  if (u.includes("generativelanguage")) {
    world.geminiCalls += 1; world.geminiBodies.push(body);
    if (world.geminiDown) return json({ error: { message: "quota" } }, 429);
    const next = world.script.shift();
    if (!next) return json({ candidates: [{ content: { role: "model", parts: [{ text: "Certo!" }] } }] });
    return json({ candidates: [{ content: { role: "model", parts: typeof next === "function" ? next(body) : next } }] });
  }
  if (u.endsWith("/chat-order")) {
    if (body.sessionId !== SID) return json({ ok: false, error: "Pedidos por conversa não estão habilitados para esta loja." }, 403);
    if (body.action === "catalog") return json({ ok: true, ...CATALOG, store: world.store, customer: world.customer });
    if (body.action === "receipt") {
      const found = world.placed.get(body.draftId);
      return json(found ? { ok: true, found: true, ...found } : { ok: true, found: false });
    }
    if (!world.store.isOpen) return json({ ok: false, error: "A loja está fechada agora." }, 409);
    const calc = price(body);
    if (body.action === "preview") {
      world.previews.push(body);
      return json({ ok: true, quoteToken: "q-" + body.draftId + "-" + world.previews.length, expires: Date.now() + 300_000, ...calc });
    }
    if (body.action === "commit") {
      world.commits.push(body);
      const existing = world.placed.get(body.draftId);
      if (existing) return json({ ok: true, ...existing, duplicate: true, status: "pending" });
      const order = { orderId: "00000000-0000-4000-8000-00000000000" + world.placed.size, orderNumber: String(1234 + world.placed.size), total: calc.total };
      world.placed.set(body.draftId, order);
      if (world.commitFailOnce) { world.commitFailOnce = false; return json({ ok: false, error: "timeout" }, 504); }
      return json({ ok: true, ...order, duplicate: false, status: "pending" });
    }
  }
  return json({ ok: false }, 404);
};

// ---------------------------------------------------------------- helpers de conversa
const call = (name, args = {}) => ({ functionCall: { name, args } });
const say = (text) => ({ text });
function customer(phone, { sid = SID, name = "Renilson" } = {}) {
  const sent = []; let paused = 0;
  const send = async (text, extra = {}) => {
    const before = sent.length;
    const handled = await handleAtendenteMessage({ sessionId: sid, customerJid: phone + "@s.whatsapp.net", customerPhone: phone,
      customerName: name, text, sendMessage: async (m) => { sent.push(m); }, pauseForHuman: async () => { paused += 1; },
      periodGreeting: () => "Boa noite", logger: { info() {}, warn() {} }, ...extra });
    return { handled, replies: sent.slice(before), last: sent[sent.length - 1] || "" };
  };
  return { send, sent, paused: () => paused };
}
const lastFunctionResponses = () => {
  const body = world.geminiBodies[world.geminiBodies.length - 1];
  const turn = body.contents[body.contents.length - 1];
  return (turn.parts || []).filter((p) => p.functionResponse).map((p) => p.functionResponse);
};

// =========================================================================
test("busca tolerante: apelidos, erros de digitação e tamanhos", () => {
  assert.equal(resolveProduct(CATALOG, "coca 2l").product?.id, "c-2l");
  assert.equal(resolveProduct(CATALOG, "coca 2 litros").product?.id, "c-2l");
  assert.equal(resolveProduct(CATALOG, "coca lata").product?.id, "c-350");
  assert.equal(resolveProduct(CATALOG, "x-tudo").product?.id, "x-tud");
  assert.equal(resolveProduct(CATALOG, "xtudo").product?.id, "x-tud");
  assert.equal(resolveProduct(CATALOG, "x tudo turbo").product?.id, "x-tud");
  assert.equal(resolveProduct(CATALOG, "xsalada").product?.id, "x-sal");
  assert.equal(resolveProduct(CATALOG, "piza media").product?.id, "p-med");
  assert.equal(resolveProduct(CATALOG, "pizza").product, undefined, "pizza sem tamanho é ambíguo");
  assert.equal(resolveProduct(CATALOG, "pizza").candidates.length, 2);
  assert.ok(searchProducts(CATALOG, "calabresa chedar").some((m) => m.product.id === "p-med"), "sabor encontra a pizza");
  const med = PRODUCTS[0];
  assert.equal(resolveOption(med, "calabresa chedar e bacon")?.option.id, "o-ccb");
  assert.equal(resolveOption(med, "borda catupiry")?.option.id, "o-bcat");
  assert.equal(resolveOption(med, "calabreza")?.option.id, "o-cal");
  assert.equal(searchProducts(CATALOG, "lasanha").length, 0);
});

test("confirmações digitadas aceitas e recusadas", () => {
  for (const t of ["sim", "Sim!", "pode", "confirma", "isso", "pode mandar", "fechado", "ok pode", "sim por favor", "ss"]) assert.ok(isPureYes(t), t);
  for (const t of ["sim, mas no débito", "não", "pode tirar a coca", "sim com borda", "quero mais uma"]) assert.ok(!isPureYes(t), t);
});

test("saudação: igual à de antes, sem botão, com link curto e sem IA", async () => {
  resetWorld();
  const c = customer("5531990000001");
  const r = await c.send("Boa noite");
  assert.equal(r.handled, true);
  assert.equal(world.geminiCalls, 0);
  assert.equal(r.last, "Boa noite! 👋 Seja bem-vindo a *Click Testes*\n\n> Confira nosso cardápio e faça seu pedido por aqui. 😊\n" +
    "É só clicar no link abaixo para ver o cardápio!\n👉 clickaipedidos.com.br/click-testes");
});

test("pedido simples no estilo Brendi: endereço/pagamento do último pedido, troca para débito, resumo e sim", async () => {
  resetWorld();
  const c = customer("5531990000002");
  world.script.push([call("adicionar_item", { produto: "x tudo" })],
    [say("Anotado: 1 X-Tudo Turbo por R$ 34,90 😋\nPosso usar a entrega na Rua das Flores, nº 123 e o pagamento no crédito, como no seu último pedido?")]);
  let r = await c.send("Quero um x tudo");
  assert.match(r.last, /Rua das Flores/);
  world.script.push([call("definir_entrega", { tipo: "entrega", usar_endereco_salvo: true }), call("definir_pagamento", { forma: "debito" }), call("gerar_resumo")]);
  r = await c.send("Sim, mas vou pagar no débito");
  assert.match(r.last, /Resumo do seu pedido/);
  assert.match(r.last, /1x X- Tudo Turbo — R\$ 34,90/);
  assert.match(r.last, /Rua das Flores, 123 - Centro/);
  assert.match(r.last, /débito/);
  assert.match(r.last, /Taxa de entrega: R\$ 4,99/);
  assert.match(r.last, /\*Total: R\$ 39,89\*/);
  assert.match(r.last, /Posso confirmar o seu pedido\?/);
  const calls = world.geminiCalls;
  r = await c.send("sim");
  assert.equal(world.geminiCalls, calls, "confirmação não passa pela IA");
  assert.equal(world.commits.length, 1);
  assert.equal(world.commits[0].paymentMethod, "debit");
  assert.equal(world.commits[0].neighborhood, "Centro");
  assert.equal(world.commits[0].name, "Renilson Alves");
  assert.match(r.last, /Nº 1234\* foi enviado para a loja/);
  assert.match(r.last, /Te aviso assim que for aceito/);
});

test("pedido duplicado: 'sim' de novo e falha incerta nunca gravam duas vezes", async () => {
  resetWorld();
  const c = customer("5531990000003");
  world.script.push([call("adicionar_item", { produto: "coca 2l" }), call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  await c.send("uma coca 2l pra retirar, pago no pix");
  world.commitFailOnce = true;      // a gravação entra, mas a resposta se perde
  let r = await c.send("pode mandar");
  assert.equal(world.placed.size, 1);
  assert.match(r.last, /Nº 1234/);
  r = await c.send("sim");
  assert.match(r.last, /já foi enviado/);
  assert.equal(world.placed.size, 1);
  assert.equal(world.commits.length, 1);
});

test("meio a meio e opção obrigatória faltando (pergunta uma vez)", async () => {
  resetWorld();
  const c = customer("5531990000004");
  world.script.push([call("adicionar_item", { produto: "pizza media" })], [say("Qual sabor? Pode escolher até 2: Calabresa, Frango com Catupiry, Calabresa com Cheddar e Bacon ou Portuguesa.")]);
  await c.send("quero uma pizza média");
  const fr = lastFunctionResponses()[0];
  assert.equal(fr.response.erro, "faltam_opcoes");
  world.script.push([call("adicionar_item", { produto: "p-med", opcoes: ["calabresa", "portuguesa"] })], [say("Fechado: Pizza Média meio Calabresa, meio Portuguesa — R$ 45,00. É para entrega?")]);
  await c.send("meio calabresa meio portuguesa");
  world.script.push([call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "credito" }), call("gerar_resumo")]);
  const r = await c.send("vou retirar, no cartão");
  assert.match(r.last, /1x Pizza Média — R\$ 45,00/);
  assert.match(r.last, /↳ com Calabresa, Portuguesa/);
  assert.match(r.last, /Retirada na loja/);
});

test("borda, adicional e observação entram no resumo com preço do backend", async () => {
  resetWorld();
  const c = customer("5531990000005");
  world.script.push([
    call("adicionar_item", { produto: "pizza grande", opcoes: ["calabresa chedar e bacon", "borda catupiry"] }),
    call("adicionar_item", { produto: "xtudo", opcoes: ["cheddar"], observacao: "sem cebola" }),
    call("definir_entrega", { tipo: "entrega", usar_endereco_salvo: true }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  const r = await c.send("uma grande calabresa cheddar e bacon com borda de catupiry e um xtudo com cheddar sem cebola, mesmo endereço no pix");
  assert.match(r.last, /1x Pizza Grande — R\$ 73,00/);
  assert.match(r.last, /Calabresa com Cheddar e Bacon \(\+R\$ 5,00\), Catupiry \(\+R\$ 8,00\)/);
  assert.match(r.last, /1x X- Tudo Turbo — R\$ 35,90/);
  assert.match(r.last, /Obs: sem cebola/);
  assert.match(r.last, /\*Total: R\$ 113,89\*/);
});

test("trocar endereço depois do resumo gera novo resumo e grava o novo bairro", async () => {
  resetWorld();
  const c = customer("5531990000006");
  world.script.push([call("adicionar_item", { produto: "x salada" }), call("definir_entrega", { tipo: "entrega", usar_endereco_salvo: true }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  await c.send("um x salada no pix, mesmo endereço");
  world.script.push([call("definir_entrega", { tipo: "entrega", rua: "Rua B", numero: "45", bairro: "santa helena" }), call("gerar_resumo")]);
  let r = await c.send("na verdade entrega na rua B 45 santa helena");
  assert.match(r.last, /Rua B, 45 - Santa Helena/);
  assert.match(r.last, /Taxa de entrega: R\$ 2,50/);
  r = await c.send("confirma");
  assert.equal(world.commits.at(-1).neighborhood, "Santa Helena");
  assert.equal(world.commits.at(-1).address, "Rua B");
});

test("bairro fora da área é recusado com a lista de bairros", async () => {
  resetWorld();
  const c = customer("5531990000007");
  world.script.push([call("adicionar_item", { produto: "x salada" }), call("definir_entrega", { tipo: "entrega", rua: "Rua C", numero: "9", bairro: "Savassi" })], [say("Não encontrei Savassi na nossa área 😕 Atendemos Centro e Santa Helena. Quer retirar na loja?")]);
  await c.send("x salada pra rua c 9 savassi");
  assert.equal(lastFunctionResponses()[1].response.erro, "bairro_fora_da_area");
});

test("dinheiro com troco: pergunta o troco, mostra no resumo e envia ao backend", async () => {
  resetWorld();
  const c = customer("5531990000008");
  world.script.push([call("adicionar_item", { produto: "x salada" }), call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "dinheiro" }), call("gerar_resumo")], [say("Precisa de troco? Para quanto?")]);
  let r = await c.send("x salada pra retirar, pago em dinheiro");
  assert.equal(lastFunctionResponses()[3].response.erro, "faltam_dados");
  assert.match(r.last, /troco/i);
  world.script.push([call("definir_pagamento", { forma: "dinheiro", troco_para: 50 }), call("gerar_resumo")]);
  r = await c.send("troco pra 50");
  assert.match(r.last, /Troco para R\$ 50,00/);
  await c.send("sim");
  assert.equal(world.commits.at(-1).changeFor, 50);
  assert.equal(world.commits.at(-1).paymentMethod, "money");
});

test("remover item e mudar quantidade", async () => {
  resetWorld();
  const c = customer("5531990000009");
  world.script.push([call("adicionar_item", { produto: "x salada", quantidade: 2 }), call("adicionar_item", { produto: "coca 350" })], [say("Anotado!")]);
  await c.send("2 x salada e uma coca lata");
  world.script.push([call("remover_item", { produto: "coca" }), call("alterar_item", { produto: "x salada", nova_quantidade: 3 }), call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  const r = await c.send("tira a coca e põe 3 x salada, retiro e pago no pix");
  assert.match(r.last, /3x X- Salada — R\$ 66,00/);
  assert.doesNotMatch(r.last, /Coca/);
});

test("produto inexistente e esgotado não entram no carrinho", async () => {
  resetWorld();
  const c = customer("5531990000010");
  world.script.push([call("adicionar_item", { produto: "lasanha" }), call("adicionar_item", { produto: "pudim" })], [say("Não temos lasanha, e o pudim acabou hoje 😕")]);
  await c.send("quero uma lasanha e um pudim");
  const [a, b] = lastFunctionResponses();
  assert.equal(a.response.erro, "nao_encontrado");
  assert.equal(b.response.erro, "esgotado");
  world.script.push([call("gerar_resumo")], [say("Ainda não tem nada no pedido.")]);
  await c.send("fecha o pedido");
  assert.equal(lastFunctionResponses()[0].response.erro, "faltam_dados");
});

test("loja fechada: saudação avisa quando abre e não monta pedido", async () => {
  resetWorld();
  world.store = { ...STORE, isOpen: false, closesAt: null, opensAt: "amanhã às 18:00" };
  const c = customer("5531990000011");
  let r = await c.send("oi");
  assert.match(r.last, /estamos fechados — abrimos amanhã às 18:00/);
  world.script.push([call("adicionar_item", { produto: "x salada" })], [say("Estamos fechados agora, abrimos amanhã às 18:00.")]);
  r = await c.send("quero um x salada");
  assert.equal(lastFunctionResponses()[0].response.erro, "loja_fechada");
  assert.equal(world.previews.length, 0);
});

test("'sim' depois de mudar o carrinho gera novo resumo (não grava o antigo)", async () => {
  resetWorld();
  const c = customer("5531990000012");
  world.script.push([call("adicionar_item", { produto: "x salada" }), call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  await c.send("x salada pra retirar no pix");
  // A IA adiciona e esquece de refazer o resumo:
  world.script.push([call("adicionar_item", { produto: "coca 2l" })], [say("Coloquei a Coca 2L! Posso confirmar o seu pedido?")]);
  await c.send("adiciona uma coca 2l");
  let r = await c.send("sim");
  assert.equal(world.commits.length, 0, "não grava resumo velho");
  assert.match(r.last, /atualizei o resumo/);
  assert.match(r.last, /\*Total: R\$ 39,99\*/);
  r = await c.send("sim");
  assert.equal(world.commits.length, 1);
  assert.equal(world.commits[0].items.length, 2);
});

test("'sim' para outra pergunta não confirma pedido", async () => {
  resetWorld();
  const c = customer("5531990000013");
  world.script.push([call("adicionar_item", { produto: "x salada" }), call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  await c.send("x salada pra retirar no pix");
  world.script.push([say("A taxa para o Centro é R$ 4,99. Quer incluir uma bebida?")]);
  await c.send("qual a taxa pro centro?");
  world.script.push([say("Qual bebida?")]);
  await c.send("sim");
  assert.equal(world.commits.length, 0);
});

test("Gemini fora do ar (429): resposta educada com link e carrinho preservado", async () => {
  resetWorld();
  const c = customer("5531990000014");
  world.script.push([call("adicionar_item", { produto: "x salada" })], [say("Anotado!")]);
  await c.send("um x salada");
  world.geminiDown = true;
  let r = await c.send("e uma coca 2l");
  assert.match(r.last, /instabilidade/);
  assert.match(r.last, /continua salvo/);
  assert.match(r.last, /clickaipedidos\.com\.br\/click-testes/);
  // Volta ao normal e o carrinho continua lá.
  world.geminiDown = false;
  world.script.push([call("adicionar_item", { produto: "coca 2l" }), call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  r = await c.send("e uma coca 2l, retiro, pix");
  assert.match(r.last, /X- Salada/);
  assert.match(r.last, /Coca cola 2L/);
  // Confirmação funciona mesmo com o Gemini fora.
  world.geminiDown = true;
  r = await c.send("sim");
  assert.equal(world.commits.length, 1);
});

test("pedir atendente pausa o robô para o cliente", async () => {
  resetWorld();
  const c = customer("5531990000015");
  const r = await c.send("quero falar com um atendente");
  assert.equal(c.paused(), 1);
  assert.equal(world.geminiCalls, 0);
  assert.match(r.last, /chamei alguém da loja/);
  world.script.push([call("chamar_atendente")]);
  await c.send("me passa pra alguém de verdade por favor, não entendi nada");
  assert.equal(c.paused(), 2);
});

test("roteamento: outras lojas, pedidos já feitos e conversas pendentes ficam no fluxo atual", async () => {
  resetWorld();
  const other = customer("5531990000016", { sid: "22222222-2222-4222-8222-222222222222" });
  assert.equal((await other.send("Boa noite")).handled, false);
  const c = customer("5531990000017");
  assert.equal((await c.send("cadê meu pedido?")).handled, false);
  assert.equal((await c.send("quero cancelar meu pedido")).handled, false);
  assert.equal((await c.send("sim", { legacyBusy: true })).handled, false);
  assert.equal((await c.send("oi", { customerPhone: null })).handled, false);
});

test("carrinho sobrevive a reinício do robô", async () => {
  resetWorld();
  const c = customer("5531990000018");
  world.script.push([call("adicionar_item", { produto: "x salada" }), call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  await c.send("x salada retirada pix");
  resetStateForTests();            // simula reinício (memória zerada, arquivo no disco)
  const r = await c.send("sim");
  assert.equal(world.commits.length, 1);
  assert.match(r.last, /foi enviado para a loja/);
});

test("isolamento por loja: mesmo número em outra loja piloto não vê o carrinho", async () => {
  resetWorld();
  const SID2 = "33333333-3333-4333-8333-333333333333";
  process.env.WHATSAPP_AI_ORDER_TENANTS = SID + "," + SID2;
  try {
    const a = customer("5531990000019");
    world.script.push([call("adicionar_item", { produto: "x salada" })], [say("Anotado!")]);
    await a.send("um x salada");
    const b = customer("5531990000019", { sid: SID2 });
    const r = await b.send("Boa noite");
    assert.equal(r.handled, false, "loja não liberada no backend fica no fluxo atual");
  } finally {
    process.env.WHATSAPP_AI_ORDER_TENANTS = SID;
  }
});

test("valores totais escritos pela IA são removidos (só o resumo oficial mostra total)", async () => {
  resetWorld();
  const c = customer("5531990000020");
  world.script.push([call("adicionar_item", { produto: "x salada" })], [say("Anotado o X-Salada!\nTotal: R$ 10,00\nVai ser entrega ou retirada?")]);
  const r = await c.send("um x salada");
  assert.doesNotMatch(r.last, /Total: R\$ 10/);
  assert.match(r.last, /entrega ou retirada/);
});

// =========================================================================
// Pedido já feito: adicionar nele, mover item do carrinho, cancelar qual e atendente indevido.
const jidOf = (phone) => phone + "@s.whatsapp.net";

test("acompanhar pedido e depois 'adicionar bebida': escolhe pelo cardápio e vai para o pedido Nº 2473 (não cria pedido novo)", async () => {
  resetWorld();
  const c = customer("5531990000101");
  await noteOrderContext(SID, jidOf("5531990000101"), "2473");
  world.script.push([call("buscar_cardapio", { termo: "bebida" })], [say("Temos Coca cola 2L (R$ 17,99) e Coca cola 350ml (R$ 6,00). Qual você prefere?")]);
  let r = await c.send("Quero adicionar alguma bebida para pagar no Pix, qual tem ?");
  assert.equal(r.handled, true);
  assert.match(r.last, /Coca cola 350ml/);
  world.script.push([call("adicionar_item", { produto: "c-350" })]);
  r = await c.send("Coca lata");
  assert.equal(typeof r.handled, "string", "vai para o fluxo de pedido já feito");
  assert.match(r.handled, /adicionar no meu pedido Nº 2473: 1x Coca cola 350ml/);
  assert.match(r.handled, /Pix/);
  assert.equal(world.previews.length, 0, "não montou resumo de pedido novo");
  assert.equal(world.commits.length, 0);
  // Depois disso, um pedido novo volta ao normal.
  world.script.push([call("adicionar_item", { produto: "x-sal" })], [say("Anotado: 1 X- Salada!")]);
  r = await c.send("agora quero fazer outro pedido, um x salada");
  assert.equal(r.handled, true);
});

test("'quero adicionar ela no pedido que acabei de fazer' move o item do carrinho, sem duplicar", async () => {
  resetWorld();
  const c = customer("5531990000102");
  await noteOrderContext(SID, jidOf("5531990000102"), "2473");
  world.script.push([call("sair_modo_adicionar"), call("adicionar_item", { produto: "c-350" })], [say("Anotado: 1 Coca cola 350ml.")]);
  await c.send("quero fazer um pedido novo de uma coca lata");
  const calls = world.geminiCalls;
  const r = await c.send("Na verdade eu quero adicionar ela no pedido que acabei de fazer");
  assert.equal(world.geminiCalls, calls, "decidido sem IA");
  assert.equal(typeof r.handled, "string");
  assert.match(r.handled, /Nº 2473: 1x Coca cola 350ml\./);
  assert.doesNotMatch(r.handled, /2x/);
  // Carrinho foi esvaziado: "sim" não grava nada.
  await c.send("sim");
  assert.equal(world.commits.length, 0);
});

test("'quero cancelar o pedido' com carrinho aberto e pedido recente pergunta qual", async () => {
  resetWorld();
  const c = customer("5531990000103");
  await noteOrderContext(SID, jidOf("5531990000103"), "2473");
  world.script.push([call("sair_modo_adicionar"), call("adicionar_item", { produto: "c-2l" })], [say("Anotado!")]);
  await c.send("quero um pedido novo, uma coca 2l");
  let r = await c.send("Quero cancelar o pedido");
  assert.equal(r.handled, true);
  assert.match(r.last, /este pedido que estamos montando/);
  assert.match(r.last, /pedido Nº 2473/);
  assert.equal(c.paused(), 0, "não chama atendente");
  r = await c.send("o pedido 2473");
  assert.equal(r.handled, "Quero cancelar o meu pedido Nº 2473");

  const d = customer("5531990000104");
  await noteOrderContext(SID, jidOf("5531990000104"), "2473");
  world.script.push([call("sair_modo_adicionar"), call("adicionar_item", { produto: "c-2l" })], [say("Anotado!")]);
  await d.send("quero um pedido novo, uma coca 2l");
  await d.send("quero cancelar");
  r = await d.send("esse carrinho");
  assert.match(r.last, /cancelei o pedido que estávamos montando/);
  assert.match(r.last, /2473 continua normal/);
  await d.send("sim");
  assert.equal(world.commits.length, 0);
});

test("cancelar sem pedido recente: limpa o carrinho na hora, sem IA e sem atendente", async () => {
  resetWorld();
  const c = customer("5531990000105");
  world.script.push([call("adicionar_item", { produto: "x-sal" })], [say("Anotado!")]);
  await c.send("um x salada");
  const calls = world.geminiCalls;
  const r = await c.send("quero cancelar o pedido");
  assert.equal(world.geminiCalls, calls);
  assert.match(r.last, /cancelei o pedido que estávamos montando/);
  assert.equal(c.paused(), 0);
});

test("IA chamando atendente sem o cliente pedir é ignorada", async () => {
  resetWorld();
  const c = customer("5531990000106");
  world.script.push([call("chamar_atendente")]);
  const r = await c.send("hmm deixa eu pensar");
  assert.equal(c.paused(), 0);
  assert.match(r.last, /atendente/);
});

test("'adicionar' sem contexto recente mas com pedido feito há pouco: pergunta se é no pedido ou pedido novo", async () => {
  resetWorld();
  world.customer = { ...CUSTOMER, lastOrderAt: new Date(Date.now() - 40 * 60_000).toISOString() };
  const c = customer("5531990000107");
  let r = await c.send("quero adicionar uma coca 2l");
  assert.match(r.last, /pedido que você já fez\* ou fazer um \*pedido novo/);
  world.script.push([call("adicionar_item", { produto: "c-2l" })], [say("Anotado: 1 Coca cola 2L!")]);
  r = await c.send("pedido novo");
  assert.equal(r.handled, true);
  assert.match(r.last, /Coca cola 2L/);
  world.customer = CUSTOMER;
});

// ======================= Auditoria 13/11: casos reais que deram errado =======================
test("textos: troca de pagamento e número de pedido sozinho", () => {
  for (const t of ["Quero colocar para pagar na entrega", "vou pagar no pix", "muda a forma de pagamento", "quero trocar o pagamento pra dinheiro", "posso pagar no cartão?"])
    assert.equal(wantsPaymentChange(t), true, t);
  for (const t of ["Quero adicionar alguma bebida para pagar no Pix", "troco para 100", "quero um x salada", "qual o valor?"])
    assert.equal(wantsPaymentChange(t), false, t);
  for (const t of ["2248", "nº 2248", "#2248", "pedido 2248", "o pedido 2248"]) assert.equal(isOrderNumberOnly(t), true, t);
  for (const t of ["2 coca", "quero 2248 cocas", "rua 1234"]) assert.equal(isOrderNumberOnly(t), false, t);
});

test("aviso da loja 'pedido N° 2248 em produção' + 'acrescentar mais um hot dog' vai para o pedido 2248 (não abre pedido novo)", async () => {
  resetWorld();
  const c = customer("5531972447117");
  noteOutboundOrderMessage(SID, "31972447117", "Renilson, o pedido N° 2248 está em produção.");
  world.script.push([call("adicionar_item", { produto: "x-sal" })]);
  const r = await c.send("Queria acrescentar mais um x salada");
  assert.equal(typeof r.handled, "string", "vai para o fluxo de pedido já feito");
  assert.match(r.handled, /adicionar no meu pedido Nº 2248: 1x X- Salada/);
  assert.equal(world.previews.length, 0);
});

test("'2248' sozinho depois de falar do pedido vai para o fluxo de pedido feito, sem IA", async () => {
  resetWorld();
  const c = customer("5531990000201");
  await noteOrderContext(SID, jidOf("5531990000201"), "");
  const calls = world.geminiCalls;
  const r = await c.send("2248");
  assert.equal(r.handled, false);
  assert.equal(world.geminiCalls, calls);
});

test("mesmo item mandado duas vezes para o pedido feito: a segunda vez não duplica", async () => {
  resetWorld();
  const c = customer("5531990000202");
  await noteOrderContext(SID, jidOf("5531990000202"), "2248");
  world.script.push([call("sair_modo_adicionar"), call("adicionar_item", { produto: "x-sal" })], [say("Anotado!")]);
  await c.send("um x salada");
  let r = await c.send("é para acrescentar no mesmo pedido acima 2248");
  assert.equal(typeof r.handled, "string");
  assert.match(r.handled, /Nº 2248: 1x X- Salada/);
  // A IA errou e colocou o mesmo item de novo no carrinho; o cliente repete "já está no pedido 2248".
  world.script.push([call("adicionar_item", { produto: "x-sal" })], [say("Anotado!")]);
  await c.send("ok");
  r = await c.send("Já está escrito isso no pedido acima 2248");
  assert.equal(r.handled, true, "não manda a alteração de novo para a loja");
  assert.match(r.last, /já foi enviado para a loja/);
  await c.send("sim");
  assert.equal(world.commits.length, 0);
});

test("depois do pedido feito, 'quero colocar para pagar na entrega' não cria pedido duplicado", async () => {
  resetWorld();
  const c = customer("5531990000203");
  world.script.push([call("adicionar_item", { produto: "x-sal" }), call("definir_entrega", { tipo: "entrega", usar_endereco_salvo: true }),
    call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  await c.send("um x salada no mesmo endereço, pix");
  await c.send("sim");
  assert.equal(world.commits.length, 1);
  const calls = world.geminiCalls;
  const r = await c.send("Quero colocar para pagar na entrega");
  assert.equal(typeof r.handled, "string");
  assert.match(r.handled, /trocar a forma de pagamento do meu pedido Nº 1234/);
  assert.equal(world.geminiCalls, calls, "decidido sem IA");
  await c.send("sim");
  assert.equal(world.commits.length, 1, "nenhum pedido novo");
});

test("resumo deixa claro que o adicional já está somado no valor do item", async () => {
  resetWorld();
  const c = customer("5531990000204");
  world.script.push([call("adicionar_item", { produto: "xtudo", opcoes: ["catupiry"] }),
    call("definir_entrega", { tipo: "retirada" }), call("definir_pagamento", { forma: "pix" }), call("gerar_resumo")]);
  const r = await c.send("um x tudo com catupiry pra retirar, pix");
  assert.match(r.last, /1x X- Tudo Turbo — R\$ 36,90/);
  assert.match(r.last, /↳ com catupiry \(\+R\$ 2,00\) — já incluso/);
});

// ======================= Auditoria 13/11 (tarde) =======================
test("'cancela a coca' com mais itens tira só a coca (não apaga o pedido todo)", async () => {
  resetWorld();
  const c = customer("5531990000301");
  world.script.push([call("adicionar_item", { produto: "x-sal" }), call("adicionar_item", { produto: "c-2l" })], [say("Anotado!")]);
  await c.send("um x salada e uma coca 2l");
  world.script.push([call("remover_item", { produto: "coca" })], [say("Tirei a Coca. Ficou 1 X- Salada.")]);
  const calls = world.geminiCalls;
  const r = await c.send("cancela a coca");
  assert.ok(world.geminiCalls > calls, "foi para a IA tirar o item");
  assert.doesNotMatch(r.last, /cancelei o pedido/);
  assert.match(r.last, /X- Salada/);
});

test("endereço novo sem bairro: IA não pode presumir o bairro do último pedido", async () => {
  resetWorld();
  const c = customer("5531990000302");
  world.script.push([call("adicionar_item", { produto: "x-sal" }), call("definir_entrega", { tipo: "entrega", rua: "Rua Nova", numero: "10", bairro: "Centro" })],
    [say("Qual é o bairro?")]);
  await c.send("um x salada pra entregar na rua nova 10");
  const fr = lastFunctionResponses().find((f) => f.name === "definir_entrega");
  assert.equal(fr.response.erro, "confirmar_bairro");
  world.script.push([call("definir_entrega", { tipo: "entrega", rua: "Rua Nova", numero: "10", bairro: "Centro" })], [say("Anotado!")]);
  await c.send("é no centro mesmo");
  assert.equal(lastFunctionResponses().find((f) => f.name === "definir_entrega").response.ok, true);
});

test("nome vindo só do perfil do WhatsApp: a IA é avisada para confirmar", async () => {
  resetWorld();
  world.customer = null;
  const c = customer("5531990000303", { name: "Consultor" });
  world.script.push([say("O que vai ser hoje?")]);
  await c.send("quero fazer um pedido");
  const system = JSON.stringify(world.geminiBodies[world.geminiBodies.length - 1].system_instruction);
  assert.match(system, /veio do perfil do WhatsApp/);
  world.customer = CUSTOMER;
});

test("pergunta 'e pão de sal?' não adiciona; pedido 'quero' adiciona; sem 'mais um' com carrinho vazio", async () => {
  resetWorld();
  const c = customer("5531990000401");
  world.script.push([call("adicionar_item", { produto: "x-sal" })], [say("Temos sim! X- Salada por R$ 22,00. Quer pedir?")]);
  let r = await c.send("e x salada?");
  assert.equal(lastFunctionResponses().find((f) => f.name === "adicionar_item").response.erro, "cliente_so_perguntou");
  assert.match(r.last, /Quer pedir/);
  world.script.push([call("adicionar_item", { produto: "x-sal" })], [say("Adicionei mais um X- Salada (R$ 22,00)! Entrega ou retirada?")]);
  r = await c.send("quero um");
  assert.equal(lastFunctionResponses().find((f) => f.name === "adicionar_item").response.ok, true);
  assert.match(r.last, /^Adicionei um X- Salada/);
});

test("entrega iFood: manda link de endereço, recebe a cotação, pede bandeira e grava com a cotação", async () => {
  resetWorld();
  world.store = { ...STORE, deliveryMode: "ifood", deliveryFees: [] };
  const c = customer("5531990000077");
  world.script.push([call("adicionar_item", { produto: "x salada" }), call("definir_entrega", { tipo: "entrega" })],
    (body) => [say("Preencha seu endereço aqui: " + JSON.stringify(body).match(/clickaipedidos\.com\.br\/e\/[A-Za-z0-9]{10}/)[0])]);
  let r = await c.send("quero um x salada pra entregar");
  const id = r.last.match(/\/e\/([A-Za-z0-9]{10})/)[1];
  assert.equal(getAddressLink(id).sessionId, SID);
  const bad = await applyAddressFromLink("XXXXXXXXXX", {});
  assert.equal(bad.ok, false);
  const ok = await applyAddressFromLink(id, {
    quote: { id: "11111111-2222-4333-8444-555555555555", feeCents: 750, expiresAt: new Date(Date.now() + 600_000).toISOString(),
      paymentMethods: [{ id: "a", method: "CREDIT", brand: "Visa" }, { id: "b", method: "CASH" }] },
    address: { streetName: "Rua A", streetNumber: "10", neighborhood: "Centro", city: "Belo Horizonte", state: "MG", postalCode: "30110000", complement: "", reference: "" },
  });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /R\$ 7,50/);
  assert.equal(getAddressLink(id), null);
  world.script.push([call("definir_pagamento", { forma: "pix" })], [say("Na entrega iFood não tem Pix. Cartão ou dinheiro?")]);
  await c.send(ok.text);
  assert.equal(lastFunctionResponses()[0].response.erro, "pix_na_entrega_indisponivel");
  world.script.push([call("definir_pagamento", { forma: "credito" })], [say("Qual a bandeira?")]);
  await c.send("crédito");
  assert.equal(lastFunctionResponses()[0].response.erro, "informe_bandeira");
  world.script.push([call("definir_pagamento", { forma: "credito", bandeira: "visa" }), call("gerar_resumo")]);
  r = await c.send("visa");
  assert.match(r.last, /7,50/);
  await c.send("sim");
  const commit = world.commits.at(-1);
  assert.equal(commit.ifoodQuoteId, "11111111-2222-4333-8444-555555555555");
  assert.deepEqual(commit.ifoodPaymentMethod, { method: "CREDIT", brand: "Visa" });
  assert.equal(commit.paymentMethod, "credit");
});
