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

const { handleAtendenteMessage } = await import("../dist/atendente/engine.js");
const { resetStateForTests } = await import("../dist/atendente/state.js");
const { searchProducts, resolveProduct, resolveOption } = await import("../dist/atendente/catalog.js");
const { isPureYes } = await import("../dist/atendente/text.js");

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
  const fee = body.deliveryType === "delivery" ? (world.store.deliveryFees.find((f) => f.name === body.neighborhood)?.fee ?? 0) : 0;
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

test("saudação: cumprimenta pelo nome, horário e link, sem IA", async () => {
  resetWorld();
  const c = customer("5531990000001");
  const r = await c.send("Boa noite");
  assert.equal(r.handled, true);
  assert.equal(world.geminiCalls, 0);
  assert.match(r.last, /Boa noite, Renilson!/);
  assert.match(r.last, /até as 23:00/);
  assert.match(r.last, /clickaipedidos\.com\.br\/cardapio\/click-testes/);
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
  assert.match(r.last, /\+ Calabresa, Portuguesa/);
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
  assert.match(r.last, /cardapio\/click-testes/);
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
