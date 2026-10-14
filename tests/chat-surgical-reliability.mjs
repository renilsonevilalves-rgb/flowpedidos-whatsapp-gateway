// tests/chat-surgical-reliability.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.API_KEY = "wa-surgical-validation-key";
process.env.CHAT_RECEIPTS_DIR = join(tmpdir(), "wa-receipts-test-" + process.pid);
process.env.GEMINI_API_KEY = "wa-test-gemini-key";
process.env.GEMINI_MODEL = "test-gemini";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";

const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { saveChatSession, loadChatSession } = await import("../dist/chatMemory.js");

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "5531999966011";
const logger = { warn() {}, info() {} };
const send = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const cart = { items: [{productId:PRODUCT,quantity:2,selectedOptions:[],notes:""}],
  name:"",deliveryType:"pickup",address:"",number:"",neighborhood:"",
  complement:"",reference:"",paymentMethod:""};
const catalog = {ok:true,storeName:"Loja teste",menuUrl:"https://menu.test",
  deliveryMode:"neighborhood",products:[{id:PRODUCT,name:"Hot dog tradicional",price:12.99,optionGroups:[]}]};

test("new WhatsApp checkout template separates items, pickup and payment clearly", async () => {
  const sent = [];
  const calls = [];
  const original = globalThis.fetch;
  let state = structuredClone(cart);
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const question = JSON.parse(opts.body).contents?.[0]?.parts?.[0]?.text || "";
      if (question.includes("Renilson")) state.name = "Renilson";
      if (question.includes("dinheiro")) state.paymentMethod = "money";
      return send({ candidates:[{content:{parts:[{text:JSON.stringify({draft:state})}]}}] });
    }
    const req = JSON.parse(opts.body); calls.push(req);
    if (req.action === "catalog") return send(catalog);
    if (req.action === "preview") return send({ok:true,quoteToken:"preview.1",expires:Date.now()+60000,
      items:[{quantity:2,name:"Hot dog tradicional",total:25.98,selectedOptions:[]}],
      subtotal:25.98,deliveryFee:0,total:25.98});
    throw new Error("Unexpected action "+req.action);
  };
  const params = text => ({
    sessionId:TENANT,customerJid:"5531999966022@s.whatsapp.net",customerPhone:"5531999966022",
    text,logger,sendMessage:async (_jid, data)=>sent.push(data.text),
  });
  try {
    await handleChatOrderMessage(params("quero 2 hot dog tradicional para retirada"));
    await handleChatOrderMessage(params("Renilson"));
    await handleChatOrderMessage(params("dinheiro"));
    assert.match(sent.at(-1), /Confira seu pedido/);
    assert.match(sent.at(-1), /• 2x Hot dog tradicional — R\$\s+25,98/);
    assert.match(sent.at(-1), /📍 Retirada na loja/);
    assert.doesNotMatch(sent.at(-1), /Entrega: Retirada/);
    assert.match(sent.at(-1), /Total: \*R\$\s+25,98\*/);
    assert.match(sent.at(-1), /Nome: Renilson/);
    assert.match(sent.at(-1), /Pagamento: Dinheiro/);
    assert.equal(calls.filter(x=>x.action==="commit").length, 0);
  } finally {globalThis.fetch=original}
});

test("intervening questions invalidate original quote: first SIM re-previews, second SIM commits", async () => {
  const sent=[], calls=[];
  const original=globalThis.fetch;
  let next = structuredClone(cart);
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const req=JSON.parse(opts.body);
      if (req.system_instruction?.parts?.[0]?.text.includes("atendente humanoide"))
        return send({candidates:[{content:{parts:[{text:JSON.stringify({reply:"A loja fica na Rua Central, 5."})}]}}]});
      const message=req.contents[0].parts[0].text;
      if (message.endsWith("Renilson")) next.name="Renilson";
      if (message.endsWith("dinheiro")) next.paymentMethod="money";
      return send({candidates:[{content:{parts:[{text:JSON.stringify({draft:next})}]}}]});
    }
    const req=JSON.parse(opts.body);calls.push(req);
    if (req.action==="catalog")return send(catalog);
    if (req.action==="preview") return send({ok:true,quoteToken:"quote."+calls.filter(c=>c.action==="preview").length,
      expires:Date.now()+60000,items:[{quantity:2,name:"Hot dog tradicional",total:25.98}],
      subtotal:25.98,deliveryFee:0,total:25.98});
    if (req.action==="commit")return send({ok:true,orderNumber:"5020",total:25.98,message:"Pedido recebido"});
    throw Error("Unexpected action "+req.action);
  };
  const p=text=>({sessionId:TENANT,customerJid:CUSTOMER+"@s.whatsapp.net",customerPhone:CUSTOMER,text,logger,
    getStoreInfo:async()=>({storeName:"Loja teste",aiContext:{business:{address:"Rua Central, 5"}}}),
    sendMessage:async(_jid,x)=>sent.push(x.text)});
  try {
    await handleChatOrderMessage(p("quero 2 hot dog tradicional para retirada"));
    await handleChatOrderMessage(p("Renilson"));
    await handleChatOrderMessage(p("dinheiro"));
    assert.equal(calls.filter(x=>x.action==="preview").length,1);
    await handleChatOrderMessage(p("Onde fica a loja?"));
    assert.match(sent.at(-1), /Rua Central/);
    await handleChatOrderMessage(p("SIM"));
    assert.equal(calls.filter(x=>x.action==="commit").length,0);
    assert.equal(calls.filter(x=>x.action==="preview").length,2);
    assert.match(sent.at(-1), /Confira seu pedido/);
    await handleChatOrderMessage(p("SIM"));
    assert.equal(calls.filter(x=>x.action==="commit").length,1);
  } finally {globalThis.fetch=original}
});

test("active cart is encrypted and restored independently per customer after a restart", async () => {
  const directory=await mkdtemp(join(tmpdir(),"wa-surgical-memory-"));
  const old=process.env.CHAT_MEMORY_DIR;
  process.env.CHAT_MEMORY_DIR=directory;
  try{
    const history=[{role:"user",text:"Meu nome é Maria e vou retirar" }];
    const draft={draftId:"12345678-1234-4234-8234-123456789abc",
      items:[{productId:PRODUCT,quantity:2,selectedOptions:[],notes:""}],
      name:"Maria",deliveryType:"pickup",address:"",number:"",neighborhood:"",
      complement:"",reference:"",paymentMethod:"money"};
    await saveChatSession(TENANT,CUSTOMER,history,draft);
    const recovered=await loadChatSession(TENANT,CUSTOMER);
    assert.deepEqual(recovered.history,history);
    assert.deepEqual(recovered.draft,draft);
    assert.equal((await loadChatSession(TENANT,"5531999988877")).draft,null);
    assert.equal((await loadChatSession("33333333-3333-4333-8333-333333333333",CUSTOMER)).draft,null);
    const file=(await readdir(directory))[0];
    const stored=await readFile(join(directory,file),"utf8");
    assert.doesNotMatch(stored,/Maria|12345678-1234|11111111-1111/);
    await saveChatSession(TENANT,CUSTOMER,history,null);
    assert.equal((await loadChatSession(TENANT,CUSTOMER)).draft,null);
  }finally{
    if(old===undefined)delete process.env.CHAT_MEMORY_DIR;else process.env.CHAT_MEMORY_DIR=old;
    await rm(directory,{recursive:true,force:true});
  }
});

test("after gateway restart a saved cart accepts short SIM only to re-preview, never commits directly", async () => {
  const directory=await mkdtemp(join(tmpdir(),"wa-resume-checkout-"));
  const originalDir=process.env.CHAT_MEMORY_DIR;
  const originalFetch=globalThis.fetch;
  process.env.CHAT_MEMORY_DIR=directory;
  const customer="5531999966033";
  const draft={draftId:"12345678-1234-4234-8234-123456789abc",
    items:[{productId:PRODUCT,quantity:2,notes:"",selectedOptions:[]}],
    name:"Joana",deliveryType:"pickup",address:"",number:"",
    neighborhood:"",complement:"",reference:"",paymentMethod:"money"};
  const seen=[],calls=[];
  globalThis.fetch=async (_url,opts)=>{
    const req=JSON.parse(opts.body);
    calls.push(req);
    if(req.action==="catalog")return send(catalog);
    if(req.action==="preview")return send({ok:true,quoteToken:"restored.quote",expires:Date.now()+60000,
      items:[{quantity:2,name:"Hot dog tradicional",total:25.98}],
      subtotal:25.98,deliveryFee:0,total:25.98});
    if(req.action==="commit")return send({ok:true,orderNumber:"5200",total:25.98,message:"Pedido recebido"});
    throw new Error("Unexpected endpoint");
  };
  try{
    await saveChatSession(TENANT,customer+"@s.whatsapp.net",[],draft);
    const p=text=>({sessionId:TENANT,customerJid:customer+"@s.whatsapp.net",
      customerPhone:customer,text,logger,sendMessage:async(_jid,x)=>seen.push(x.text)});
    assert.equal(await handleChatOrderMessage(p("SIM")),true);
    assert.equal(calls.filter(c=>c.action==="commit").length,0);
    assert.match(seen.at(-1),/Confira seu pedido/);
    assert.match(seen.at(-1),/Joana/);
    await handleChatOrderMessage(p("SIM"));
    assert.equal(calls.filter(c=>c.action==="commit").length,1);
    assert.equal((await loadChatSession(TENANT,customer+"@s.whatsapp.net")).draft,null);
  }finally{
    globalThis.fetch=originalFetch;
    if(originalDir===undefined)delete process.env.CHAT_MEMORY_DIR;
    else process.env.CHAT_MEMORY_DIR=originalDir;
    await rm(directory,{recursive:true,force:true});
  }
});

test("large customization summaries are sent in complete chunks with confirmation at the end", async () => {
  const originalFetch=globalThis.fetch;
  const outgoing=[],calls=[];
  const customer="5531999966077";
  const longName="Hot dog personalizado com adicionais e observacoes detalhadas ".repeat(4);
  globalThis.fetch=async(url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com")){
      return send({candidates:[{content:{parts:[{text:JSON.stringify({draft:{
        ...cart,name:"Ana",paymentMethod:"money",
      }})}]}}]});
    }
    const req=JSON.parse(opts.body); calls.push(req);
    if(req.action==="catalog")return send(catalog);
    if(req.action==="preview")return send({ok:true,quoteToken:"long.quote",expires:Date.now()+60000,
      items:Array.from({length:35},(_,i)=>({quantity:1,name:String(i+1)+" "+longName,total:25.98,selectedOptions:[]})),
      subtotal:909.3,deliveryFee:0,total:909.3});
    throw Error("No checkout allowed during preview test");
  };
  try{
    const handled=await handleChatOrderMessage({
      sessionId:TENANT,customerJid:customer+"@s.whatsapp.net",customerPhone:customer,
      text:"quero 2 hot dog tradicional para retirada",logger,
      sendMessage:async(_jid,data)=>outgoing.push(data.text),
    });
    assert.equal(handled,true);
    assert.ok(outgoing.length>=2,"long message must be split, not truncated");
    assert.ok(outgoing.every(x=>x.length<=3500));
    assert.match(outgoing.join("\n"),/35 Hot dog personalizado/);
    assert.match(outgoing.at(-1),/Responda \*SIM\* para confirmar/);
    assert.equal(calls.filter(x=>x.action==="commit").length,0);
  }finally{globalThis.fetch=originalFetch}
});
