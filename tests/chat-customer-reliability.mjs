// tests/chat-customer-reliability.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.API_KEY = "test-durable-confirmation";
process.env.GEMINI_API_KEY = "test-gemini";
process.env.GEMINI_MODEL = "test-gemini-model";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = "22222222-2222-4222-8222-222222222222";
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { saveChatSession, loadChatSession } = await import("../dist/chatMemory.js");

const TENANT = "22222222-2222-4222-8222-222222222222";
const PUDIM = "11111111-1111-4111-8111-111111111111";
const ACAI = "33333333-3333-4333-8333-333333333333";
const PASTA = "44444444-4444-4444-8444-444444444444";
const logger = { info() {}, warn() {} };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const catalog = {
  ok: true, deliveryMode: "neighborhood", storeName: "RTestes", menuUrl: "https://menu.test",
  neighborhoods: ["Bernardo Monteiro"],
  products: [
    { id: PUDIM, name: "Pudim", price: 27.89, optionGroups: [] },
    { id: ACAI, name: "Vitamina de Açaí", price: 9.99, optionGroups: [] },
    { id: PASTA, name: "Macarrão na chapa grande", price: 22.9, optionGroups: [] },
  ],
};
const receiptDraft = (items = [{productId:PUDIM,quantity:2,notes:"",selectedOptions:[]},
  {productId:ACAI,quantity:1,notes:"",selectedOptions:[]},
  {productId:PASTA,quantity:1,notes:"",selectedOptions:[]}]) => ({
  draftId: "11223344-1122-4122-8122-112233445566",
  items, name: "Renilson", deliveryType: "delivery",
  address: "Rua Tereza Cristina", number: "188", neighborhood: "Bernardo Monteiro",
  complement: "", reference: "", paymentMethod: "money",
});

test("successful checkout saves customer receipt BEFORE WhatsApp send failure and never commits twice", async () => {
  const path = await mkdtemp(join(tmpdir(),"wa-saved-receipt-"));
  const origDir = process.env.CHAT_MEMORY_DIR, origFetch = globalThis.fetch;
  process.env.CHAT_MEMORY_DIR = path;
  const phone = "5531999922271", jid = phone+"@s.whatsapp.net";
  let commits = 0, previews = 0;
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    const req=JSON.parse(options.body);
    if(req.action==="catalog")return json(catalog);
    if(req.action==="preview"){
      previews++;
      return json({ok:true,quoteToken:"signed.quote",expires:Date.now()+60000,
        items:[{quantity:1,name:"Pudim",total:27.89}],subtotal:27.89,deliveryFee:2,total:29.89});
    }
    if(req.action==="commit"){
      commits++;
      return json({ok:true,orderId:"50000000-0000-4000-8000-000000000001",
        orderNumber:"8001",total:29.89,message:"Pedido confirmado"});
    }
    if(req.action==="learn") return json({ok:true});
    throw Error("Unexpected action " + req.action);
  };
  const p=(text,fail=false)=>({sessionId:TENANT,customerJid:jid,customerPhone:phone,text,logger,
    sendMessage:async (_jid,packet)=>{
      if(fail && packet.text.includes("✅ Pedido #"))throw Error("Socket closed after commit");
      sent.push(packet.text);
    }});
  try {
    await saveChatSession(TENANT,jid,[],receiptDraft([{productId:PUDIM,quantity:1,notes:"",selectedOptions:[]}]));
    await handleChatOrderMessage(p("SIM")); // quote was lost on restart: MUST re-preview
    assert.equal(previews,1);
    assert.equal(commits,0);
    assert.match(sent.at(-1),/Confira seu pedido/);
    await handleChatOrderMessage(p("SIM",true)); // backend succeeds, socket send fails
    assert.equal(commits,1);
    const stored=await loadChatSession(TENANT,jid);
    assert.equal(stored.draft,null);
    assert.match(stored.receipt?.text || "",/Pedido #8001/);
    assert.equal(await handleChatOrderMessage(p("SIM")),true);
    assert.match(sent.at(-1),/Pedido #8001/);
    assert.equal(commits,1,"repeated SIM must NEVER commit second order");
    assert.equal((await loadChatSession(TENANT,"5531999922272@s.whatsapp.net")).receipt ?? null,null);
  }finally{
    globalThis.fetch=origFetch;
    if(origDir===undefined)delete process.env.CHAT_MEMORY_DIR;else process.env.CHAT_MEMORY_DIR=origDir;
    await rm(path,{recursive:true,force:true});
  }
});

test("removing one pudim responds with remaining quantity and official new total even when Gemini returns HTTP 429",async()=>{
  const path=await mkdtemp(join(tmpdir(),"wa-cart-edit-"));
  const oldDir=process.env.CHAT_MEMORY_DIR,oldFetch=globalThis.fetch;
  process.env.CHAT_MEMORY_DIR=path;
  const phone="5531999922273",jid=phone+"@s.whatsapp.net";
  const sent=[],requests=[];
  let geminiCalls=0;
  globalThis.fetch=async(url,options)=>{
    const req=JSON.parse(options.body);
    if(String(url).includes("generativelanguage.googleapis.com")){
      geminiCalls++;
      if(geminiCalls===1)return json({candidates:[{content:{role:"model",parts:[
        {functionCall:{name:"edit_cart",args:{operation:"remove",productId:PUDIM,quantity:1},id:"rm"}},
      ]}}]});
      return json({error:{message:"Resource exhausted"}},429);
    }
    requests.push(req);
    if(req.action==="catalog")return json(catalog);
    if(req.action==="preview"){
      assert.equal(req.items.find(x=>x.productId===PUDIM).quantity,1);
      assert.equal(req.items.length,3);
      assert.equal(req.address,"Rua Tereza Cristina");
      assert.equal(req.number,"188");
      return json({ok:true,quoteToken:"signed.changed",expires:Date.now()+60000,
        items:[{quantity:1,name:"Pudim",total:27.89},
          {quantity:1,name:"Vitamina de Açaí",total:9.99},
          {quantity:1,name:"Macarrão na chapa grande",total:22.9}],
        subtotal:60.78,deliveryFee:2,total:62.78});
    }
    if(req.action==="commit")return json({ok:true,orderNumber:"8002",total:62.78,message:"Pedido confirmado"});
    throw Error("Unknown action " + req.action);
  };
  const p=text=>({sessionId:TENANT,customerJid:jid,customerPhone:phone,text,logger,
    sendMessage:async(_jid,packet)=>sent.push(packet.text)});
  try {
    await saveChatSession(TENANT,jid,[],receiptDraft());
    assert.equal(await handleChatOrderMessage(p("Pode retirar 1 pudim")),true);
    const reply=sent.at(-1);
    assert.match(reply,/Retirei 1 unidade de \*Pudim\*/);
    assert.match(reply,/Restam 1 no pedido/);
    assert.match(reply,/Novo total: \*R\$\s*62,78\*/);
    assert.match(reply,/Responda \*SIM\* para confirmar/);
    assert.doesNotMatch(reply,/Atualizei os dados disponíveis|Vamos conferir seu pedido antes/i);
    assert.equal(requests.filter(x=>x.action==="preview").length,1);
    assert.equal(requests.filter(x=>x.action==="commit").length,0);
    await handleChatOrderMessage(p("Sim"));
    assert.equal(requests.filter(x=>x.action==="commit").length,1);
    assert.match(sent.at(-1),/Pedido #8002/);
  }finally{
    globalThis.fetch=oldFetch;
    if(oldDir===undefined)delete process.env.CHAT_MEMORY_DIR;else process.env.CHAT_MEMORY_DIR=oldDir;
    await rm(path,{recursive:true,force:true});
  }
});
