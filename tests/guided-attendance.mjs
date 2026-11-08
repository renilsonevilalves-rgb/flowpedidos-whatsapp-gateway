// Atendimento guiado por números (modo "guided" = sem IA): um pedido completo,
// do "Oi" ao "SIM", com opções obrigatórias/opcionais, remoção de item,
// endereço, bairro, pagamento e confirmação — sem nenhuma chamada ao Gemini.
import "./helpers-no-recent-order.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const SID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = SID;
process.env.GEMINI_API_KEY = "fake";
process.env.GEMINI_MODEL = "m";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "k";
process.env.HUMAN_HANDOFF_FILE = (await import("node:os")).tmpdir() + "/guided-handoff-" + process.pid + ".json";
const { handleChatOrderMessage, choiceNumber } = await import("../dist/chatOrder.js");

const XT = "11111111-aaaa-4aaa-8aaa-000000000001";
const COX = "11111111-aaaa-4aaa-8aaa-000000000002";
const COCA = "11111111-aaaa-4aaa-8aaa-000000000003";
const catalog = {
  ok: true, storeName: "Lanchonete Teste", menuUrl: "https://m", deliveryMode: "neighborhood", neighborhoods: ["Centro", "Fonte Grande"],
  customer: { name: "Renii", savedAddress: { address: "Tereza Cristina", number: "144", neighborhood: "Bairro Antigo" } },
  products: [
    { id: XT, name: "X-Tudo", price: 25, category: "Lanches", optionGroups: [
      { id: "g-ponto", name: "Ponto da carne", min: 1, max: 1, options: [{ id: "o-mal", name: "Mal passado", price: 0 }, { id: "o-bem", name: "Bem passado", price: 0 }] },
      { id: "g-add", name: "Adicionais", min: 0, max: 2, options: [{ id: "o-bacon", name: "Bacon", price: 3 }, { id: "o-ovo", name: "Ovo", price: 2 }] },
    ] },
    { id: COX, name: "Coxinha Catupiry", price: 9, category: "Lanches" },
    { id: COCA, name: "Coca cola 2L", price: 17.99, category: "Bebidas" },
  ],
};
const res = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

function harness(mode) {
  process.env.WHATSAPP_ATTENDANCE_MODE = mode;
  const sent = [], calls = { gemini: 0, preview: null, commit: null };
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("generativelanguage")) { calls.gemini++; return res({ error: "no" }, 500); }
    if (u.includes("chat-order") && body.action === "catalog") return res(catalog);
    if (u.includes("chat-order") && body.action === "preview") {
      calls.preview = body;
      return res({ ok: true, quoteToken: "q1", expires: Date.now() + 600000, subtotal: 60, deliveryFee: 5, total: 65,
        items: [{ quantity: 2, name: "X-Tudo", total: 60, selectedOptions: [{ quantity: 1, name: "Bem passado" }, { quantity: 1, name: "Bacon" }, { quantity: 1, name: "Ovo" }] }] });
    }
    if (u.includes("chat-order") && body.action === "commit") { calls.commit = body; return res({ ok: true, orderNumber: "9100", orderId: "o9100", total: 65, message: "" }); }
    return res({ ok: true });
  };
  const phone = "55319" + String(10000000 + Math.floor(Math.random() * 8999999));
  const say = async (text) => {
    sent.length = 0;
    const handled = await handleChatOrderMessage({ sessionId: SID, customerJid: phone + "@s.whatsapp.net", customerPhone: phone, text,
      logger: { info() {}, warn() {}, error() {} },
      getStoreInfo: async () => ({ storeName: "Lanchonete Teste", isOpen: true,
        openingHours: { monday: { enabled: true, open: "18:00", close: "23:00" } },
        aiContext: { delivery: { neighborhoods: [{ name: "Centro", fee: 5 }, { name: "Fonte Grande", fee: 7 }] },
          payments: { online: { pix: true, credit: false, debit: false } }, service: { preparationTimeMin: 20, preparationTimeMax: 40 } } }),
      sendMessage: async (_j, m) => { sent.push(m.text); } });
    return { handled, out: sent.join("\n") };
  };
  return { say, calls };
}

test("números: 1, 1️⃣, 'opção 2', 'dois'", () => {
  assert.equal(choiceNumber("1"), 1);
  assert.equal(choiceNumber("1️⃣"), 1);
  assert.equal(choiceNumber("opção 2"), 2);
  assert.equal(choiceNumber("dois"), 2);
  assert.equal(choiceNumber("quero 2 coxinhas"), null);
});

test("pedido completo pelo menu, sem IA, do 'Oi' ao 'SIM'", async () => {
  const { say, calls } = harness("guided");
  let r = await say("Boa noite");
  assert.match(r.out, /Boa noite, Renii/); assert.match(r.out, /1️⃣ Fazer um pedido por aqui/); assert.match(r.out, /6️⃣ Falar com um atendente/);
  r = await say("1");      assert.match(r.out, /1️⃣ Lanches/); assert.match(r.out, /2️⃣ Bebidas/);
  r = await say("1");      assert.match(r.out, /1️⃣ X-Tudo — R\$\s25,00/); assert.match(r.out, /2️⃣ Coxinha Catupiry/);
  r = await say("1");      assert.match(r.out, /Quantas unidades/);
  r = await say("2");      assert.match(r.out, /Ponto da carne/); assert.match(r.out, /2️⃣ Bem passado/);
  r = await say("5");      assert.match(r.out, /Escolha 1/, "opção inexistente é recusada");
  r = await say("2");      assert.match(r.out, /Adicionais/); assert.match(r.out, /\+R\$\s3,00/);
  r = await say("1, 2");   assert.match(r.out, /Adicionei \*2x X-Tudo\*/); assert.match(r.out, /Subtotal: \*R\$\s60,00\*/);
  r = await say("1");      assert.match(r.out, /Bebidas/);
  r = await say("2");      assert.match(r.out, /Coca cola 2L/);
  r = await say("1");      r = await say("1"); assert.match(r.out, /Adicionei \*1x Coca cola 2L\*/);
  r = await say("3");      assert.match(r.out, /Qual item você quer remover/);
  r = await say("2");      assert.match(r.out, /Removi \*1x Coca cola 2L\*/);
  r = await say("2");      assert.match(r.out, /1️⃣ Entrega/);
  r = await say("1");      assert.doesNotMatch(r.out, /Tereza Cristina/, "endereço salvo fora da área não é oferecido");
  assert.match(r.out, /Qual o seu \*bairro\*/); assert.match(r.out, /1️⃣ Centro — taxa R\$\s5,00/);
  r = await say("1");      assert.match(r.out, /rua e o número/);
  r = await say("Rua 7 de Setembro, 100, apto 2");
  assert.match(r.out, /Como prefere \*pagar\*/); assert.match(r.out, /Pix agora \(link de pagamento\)/); assert.doesNotMatch(r.out, /crédito agora/);
  r = await say("1");      assert.match(r.out, /Total: \*R\$\s65,00\*/); assert.match(r.out, /SIM/);
  assert.equal(calls.preview.deliveryType, "delivery");
  assert.equal(calls.preview.address, "Rua 7 de Setembro");
  assert.equal(calls.preview.number, "100");
  assert.equal(calls.preview.complement, "apto 2");
  assert.equal(calls.preview.neighborhood, "Centro");
  assert.equal(calls.preview.paymentMethod, "pix");
  assert.equal(calls.preview.name, "Renii");
  assert.deepEqual(calls.preview.items, [{ productId: XT, quantity: 2, selectedOptions: [
    { groupId: "g-ponto", id: "o-bem", quantity: 1 }, { groupId: "g-add", id: "o-bacon", quantity: 1 }, { groupId: "g-add", id: "o-ovo", quantity: 1 }] }]);
  r = await say("SIM");    assert.match(r.out, /Pedido #9100 confirmado/);
  assert.equal(calls.commit.quoteToken, "q1");
  assert.equal(calls.gemini, 0, "o modo guiado nunca chama a IA");
});

test("retirada, endereço salvo e informações da loja", async () => {
  const { say, calls } = harness("guided");
  await say("oi");
  let r = await say("5");
  assert.match(r.out, /Seg: 18:00 às 23:00/); assert.match(r.out, /Centro — R\$\s5,00/); assert.match(r.out, /Tempo de preparo: 20 a 40 min/);
  await say("0"); await say("1"); await say("1"); await say("2"); await say("1");
  r = await say("2");      assert.match(r.out, /1️⃣ Entrega/);
  r = await say("2");      assert.match(r.out, /pagar/); assert.match(r.out, /Pix na retirada/);
  r = await say("dinheiro"); assert.match(r.out, /SIM/);
  assert.equal(calls.preview.deliveryType, "pickup");
  assert.equal(calls.preview.paymentMethod, "money");
  assert.equal(calls.gemini, 0);
});

test("sem IA: texto livre acha o produto; texto desconhecido mostra o menu", async () => {
  const { say, calls } = harness("guided");
  let r = await say("tem coxinha?");
  assert.match(r.out, /Coxinha Catupiry/); assert.match(r.out, /Quantas unidades/);
  r = await say("blablabla xyz");
  assert.match(r.out, /quantidade/, "dentro de uma etapa, pede de novo o que falta");
  const other = harness("guided");
  r = await other.say("blablabla xyz");
  assert.match(r.out, /Não entendi muito bem/); assert.match(r.out, /1️⃣/);
  assert.equal(other.calls.gemini, 0);
  assert.equal(calls.gemini, 0);
});

test("modo guiado + IA: menu por número sem IA; frase livre vai para a IA", async () => {
  const { say, calls } = harness("guided_ai");
  await say("Oi"); await say("1");
  assert.equal(calls.gemini, 0, "navegar pelo menu não gasta IA");
  await say("na verdade quero ver se vocês entregam no bairro Fonte Grande hoje");
  assert.ok(calls.gemini > 0, "pergunta livre é entendida pela IA");
});

test("falar com atendente pelo menu pausa o robô", async () => {
  const { say } = harness("guided");
  await say("oi");
  const r = await say("6");
  assert.match(r.out, /avisei a equipe/);
});
