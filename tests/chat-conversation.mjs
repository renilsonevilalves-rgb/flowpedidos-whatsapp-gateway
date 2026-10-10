// tests/chat-conversation.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.GEMINI_API_KEY = "fake-test-gemini";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "fake-test-backend-key";

const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { isPromotionQuestion, promotionsFor, unresolvedChoice } = await import("../dist/chatConversation.js");
const BURGER = "11111111-1111-4111-8111-111111111111";
const COLA = "22222222-2222-4222-8222-222222222222";
const FANTA = "33333333-3333-4333-8333-333333333333";
const products = [
  { id: BURGER, name: "Hambúrguer", category: "Lanches", price: 21, promotionEnabled: false, originalPrice: null, optionGroups: [] },
  { id: COLA, name: "Coca cola 350ml", category: "Bebidas", price: 6, promotionEnabled: false, originalPrice: null, optionGroups: [] },
  { id: FANTA, name: "Fanta Laranja 2L", category: "Bebidas", price: 12, promotionEnabled: false, originalPrice: null, optionGroups: [] },
];
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {"Content-Type":"application/json"} });
const logger = {warn(){},info(){}};
const param = (phone,text,messages) => ({
  sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", customerJid: phone+"@s.whatsapp.net",
  customerPhone: phone, text, logger, sendMessage: async (_,x)=>messages.push(x.text),
});
function mockBackend(calls, data = products) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const request = JSON.parse(opts.body);
      const input = request.contents[0].parts[0].text;
      if (input.startsWith("Pergunta: ")) {
        return response({candidates:[{content:{parts:[{text: JSON.stringify({
          type:"availability", query:"bebidas", productIds:[COLA,FANTA],
        })}]}}]});
      }
      const wantsBurger = /hamb[uú]rguer/i.test(input.split("Mensagem atual:").at(-1));
      return response({candidates:[{content:{parts:[{text: JSON.stringify({ draft:{
        items:wantsBurger?[{productId:BURGER,quantity:1,notes:"",selectedOptions:[]}]:[],
        name:"",deliveryType:"",address:"",number:"",neighborhood:"",
        complement:"",reference:"",paymentMethod:"",
      }})}]}}]});
    }
    const req = JSON.parse(opts.body);calls.push(req);
    if (req.action === "catalog") return response({ok:true,menuUrl:"https://menu.test",
      deliveryMode:"neighborhood",products:data});
    if (req.action === "preview") throw new Error("Preview not expected until payment details exist");
    if (req.action === "commit") throw new Error("Never commit without explicit confirmation");
    throw new Error("Unknown backend action");
  };
  return () => { globalThis.fetch = previousFetch; };
}

test("promotion answers only use validated catalog flags and displayed checkout prices", () => {
  assert.equal(isPromotionQuestion("Tem algum lanche em promoção?"),true);
  assert.deepEqual(promotionsFor("Tem algum lanche em promoção?",products),[]);
  const active = [{...products[0],price:17,promotionEnabled:true,originalPrice:21},...products.slice(1)];
  assert.deepEqual(promotionsFor("Tem algum lanche em promoção?",active).map(p=>p.id),[BURGER]);
  const incorrect = [{...products[0],promotionEnabled:true,originalPrice:14},...products.slice(1)];
  assert.deepEqual(promotionsFor("Tem algum lanche em promoção?",incorrect),[]);
});
test("a generic refrigerante request remains unresolved even if Gemini guessed a size", () => {
  const choice=unresolvedChoice("Um hambúrguer e 1 refrigerantes", products, [BURGER,COLA]);
  assert.equal(choice?.topic,"refrigerante");
  assert.deepEqual(choice?.options.map(p=>p.id),[COLA,FANTA]);
  assert.equal(unresolvedChoice("Quero Coca cola 350ml",products,[]) , null);
});

test("screenshot regression: mixed order keeps burger but asks for a real beverage choice",async()=>{
  const calls=[],sent=[], restore=mockBackend(calls);
  try{
    const id="5531999919981";
    await handleChatOrderMessage(param(id,"Olá queria fazer um pedido",sent));
    await handleChatOrderMessage(param(id,"Um hambúrguer e 1 refrigerantes",sent));
    assert.match(sent.at(-1),/1x Hambúrguer/);
    assert.match(sent.at(-1),/qual \*refrigerante\*/i);
    assert.match(sent.at(-1),/Coca cola 350ml/);
    assert.doesNotMatch(sent.at(-1),/nome.*entrega.*retirada/i);
    await handleChatOrderMessage(param(id,"Qual bebida você tem ?",sent));
    assert.match(sent.at(-1),/Coca cola 350ml/);
    await handleChatOrderMessage(param(id,"Coca cola 350ml",sent));
    assert.match(sent.at(-1),/1x Hambúrguer/);
    assert.match(sent.at(-1),/1x Coca cola 350ml/);
    assert.equal(calls.filter(c=>c.action==="commit").length,0);
  }finally{restore();}
});

test("screenshot regression: empty promotion query and 'nenhum?' keep catalog context",async()=>{
  const calls=[],sent=[],restore=mockBackend(calls);
  try{
    const id="5531999919982";
    await handleChatOrderMessage(param(id,"Olá queria fazer um pedido",sent));
    await handleChatOrderMessage(param(id,"Um hambúrguer e 1 refrigerantes",sent));
    await handleChatOrderMessage(param(id,"Tem algum lanche em promoção?",sent));
    assert.match(sent.at(-1),/não encontrei lanches em promoção/i);
    assert.doesNotMatch(sent.at(-1),/nome.*entrega.*retirada/i);
    await handleChatOrderMessage(param(id,"Nenhum ?",sent));
    assert.match(sent.at(-1),/não encontrei lanches em promoção/i);
    assert.doesNotMatch(sent.at(-1),/nome.*entrega.*retirada/i);
    assert.equal(calls.filter(c=>c.action==="commit").length,0);
  }finally{restore();}
});

test("real promotion appears with only backend-verified discounted price",async()=>{
  const calls=[],sent=[];
  const restore=mockBackend(calls,[{...products[0],price:17,promotionEnabled:true,originalPrice:21},...products.slice(1)]);
  try {
    await handleChatOrderMessage(param("5531999919983","Tem algum lanche em promoção?",sent));
    assert.match(sent.at(-1),/Hambúrguer.*R\$\s*17,00/);
    assert.doesNotMatch(sent.at(-1),/nome.*entrega.*retirada/i);
    assert.equal(calls.filter(c=>c.action==="commit").length,0);
  } finally {restore();}
});
