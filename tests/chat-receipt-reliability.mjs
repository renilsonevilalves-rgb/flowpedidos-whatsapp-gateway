// tests/chat-receipt-reliability.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_ENABLED = "true";
process.env.WHATSAPP_GEMINI_AGENT_TENANTS = "22222222-2222-4222-8222-222222222222";
process.env.GEMINI_API_KEY = "agent-reliability-mock";
process.env.GEMINI_MODEL = "mock-model";
process.env.GEMINI_AGENT_MODEL = "mock-model";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "mock-encryption-key";

const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const { saveChatSession } = await import("../dist/chatMemory.js");
const { deliverOrderReceipt, drainOrderReceipts, prepareOrderReceipt } = await import("../dist/chatReceiptOutbox.js");
const TENANT = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT = "44444444-4444-4444-8444-444444444444";
const PUDIM = "11111111-1111-4111-8111-111111111111";
const ACAI = "33333333-3333-4333-8333-333333333333";
const PASTA = "55555555-5555-4555-8555-555555555555";
const PHONE = "5531999966991";
const JID = PHONE + "@s.whatsapp.net";
const mockLogger = { warn(){}, info(){} };
const json = (data,status=200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});
const catalog = { ok:true, storeName:"RTestes", menuUrl:"https://menu.test",
  deliveryMode:"neighborhood",neighborhoods:["Bernardo monteiro"],products:[
    {id:ACAI,name:"Vitamina de Açaí",price:9.99,optionGroups:[]},
    {id:PUDIM,name:"Pudim",price:27.89,optionGroups:[]},
    {id:PASTA,name:"Macarrão na chapa grande",price:22.90,optionGroups:[]},
  ]};
const draft = { draftId:"12345678-1234-4234-8234-123456789abc",
  items:[{productId:ACAI,quantity:1,selectedOptions:[],notes:""},
    {productId:PUDIM,quantity:2,selectedOptions:[],notes:""},
    {productId:PASTA,quantity:1,selectedOptions:[],notes:""}],
  name:"Renilson",deliveryType:"delivery",address:"Rua Tereza Cristina",
  number:"188",neighborhood:"Bernardo monteiro",complement:"",reference:"",paymentMethod:"money",
};
const receipt = {sessionId:TENANT, customerJid:JID, orderId:"order-123",
  text:"✅ Pedido #123 confirmado! Total: R$ 62,78"};

test("pudim removal replies with exact product and backend-verified total, without extra yes",async()=>{
  const oldFetch=globalThis.fetch, oldMemory=process.env.CHAT_MEMORY_DIR,
    oldReceipts=process.env.WHATSAPP_RECEIPT_DIR;
  const root=await mkdtemp(join(tmpdir(),"wa-reliability-"));
  process.env.CHAT_MEMORY_DIR=join(root,"memory");
  process.env.WHATSAPP_RECEIPT_DIR=join(root,"receipts");
  const sent=[],backend=[],model=[];
  let apiCalls=0;
  globalThis.fetch=async(url,opts)=>{
    const req=JSON.parse(opts.body);
    if(String(url).includes("generativelanguage.googleapis.com")){
      model.push(req);
      apiCalls++;
      if(apiCalls===1)return json({candidates:[{content:{role:"model",parts:[
        {functionCall:{name:"edit_cart",args:{operation:"remove",productId:PUDIM,quantity:1},id:"edit1"}}
      ]}}]});
      return json({error:{message:"Rate limit"}},429);
    }
    backend.push(req);
    if(req.action==="catalog")return json(catalog);
    if(req.action==="preview"){
      assert.equal(req.items.find(x=>x.productId===PUDIM)?.quantity,1);
      return json({ok:true,quoteToken:"signed-preview",expires:Date.now()+60000,
        items:[{name:"Vitamina de Açaí",quantity:1,total:9.99},
          {name:"Pudim",quantity:1,total:27.89},
          {name:"Macarrão na chapa grande",quantity:1,total:22.9}],
        subtotal:60.78,deliveryFee:2,total:62.78});
    }
    if(req.action==="commit")return json({ok:true,orderId:"order-abc",orderNumber:"3245",
      total:62.78,message:"Pedido recebido e em preparação."});
    throw Error("Unexpected request "+req.action);
  };
  const params=text=>({sessionId:TENANT,customerJid:JID,customerPhone:PHONE,text,
    logger:mockLogger,sendMessage:async(_jid,info)=>sent.push(info.text)});
  try{
    await saveChatSession(TENANT,JID,[],draft);
    assert.equal(await handleChatOrderMessage(params("Pode retirar 1 pudim")),true);
    assert.match(sent.at(-1),/Retirei \*1x Pudim\* do pedido/);
    assert.match(sent.at(-1),/Novo total: R\$\s*62,78/);
    assert.doesNotMatch(sent.at(-1),/Atualizei os dados disponíveis/);
    assert.equal(backend.filter(x=>x.action==="preview").length,1);
    assert.equal(backend.filter(x=>x.action==="commit").length,0);
    assert.equal(apiCalls,2);
    await handleChatOrderMessage(params("Sim"));
    assert.equal(backend.filter(x=>x.action==="commit").length,1);
    assert.match(sent.at(-1),/Pedido #3245 confirmado/);
    assert.equal(await drainOrderReceipts(TENANT,async()=>{throw Error("unexpected replay")},mockLogger),0);
  }finally{
    globalThis.fetch=oldFetch;
    if(oldMemory===undefined)delete process.env.CHAT_MEMORY_DIR;else process.env.CHAT_MEMORY_DIR=oldMemory;
    if(oldReceipts===undefined)delete process.env.WHATSAPP_RECEIPT_DIR;else process.env.WHATSAPP_RECEIPT_DIR=oldReceipts;
    await rm(root,{recursive:true,force:true});
  }
});

test("failed confirmation send is encrypted, survives restart and never commits a second order",async()=>{
  const root=await mkdtemp(join(tmpdir(),"wa-receipts-"));
  const old=process.env.WHATSAPP_RECEIPT_DIR;
  process.env.WHATSAPP_RECEIPT_DIR=root;
  let attempts=0;
  try{
    const ok=await deliverOrderReceipt(receipt,async()=>{
      attempts++;
      throw Error("WhatsApp socket temporarily disconnected");
    },mockLogger);
    assert.equal(ok,false);
    assert.equal(attempts,2);
    const files=await readdir(root);
    assert.equal(files.length,1);
    const encrypted=await readFile(join(root,files[0]),"utf8");
    assert.doesNotMatch(encrypted,/Pedido #123|5531999966991|R\$ 62/);
    let wrongTenantSent=0;
    assert.equal(await drainOrderReceipts(OTHER_TENANT,async()=>{
      wrongTenantSent++;
    },mockLogger),0);
    assert.equal(wrongTenantSent,0);
    const recovered=[];
    assert.equal(await drainOrderReceipts(TENANT,async(jid,data)=>{
      recovered.push({jid,text:data.text});
    },mockLogger),1);
    assert.deepEqual(recovered,[{jid:JID,text:receipt.text}]);
    assert.equal((await readdir(root)).length,0);
    assert.equal(await drainOrderReceipts(TENANT,async()=>{throw Error("duplicated")},mockLogger),0);
  }finally{
    if(old===undefined)delete process.env.WHATSAPP_RECEIPT_DIR;else process.env.WHATSAPP_RECEIPT_DIR=old;
    await rm(root,{recursive:true,force:true});
  }
});

test("crash after backend commit but before WhatsApp response recovers exactly once without re-commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-precommit-"));
  const oldDir = process.env.WHATSAPP_RECEIPT_DIR;
  const oldFetch = globalThis.fetch;
  process.env.WHATSAPP_RECEIPT_DIR = root;
  const calls = [], outbound = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    assert.equal(payload.action, "receipt");
    assert.equal(payload.sessionId, TENANT);
    assert.equal(payload.phone, PHONE);
    assert.equal(payload.draftId, draft.draftId);
    return json({
      ok: true, found: true, orderId: "66666666-6666-4666-8666-666666666666",
      orderNumber: "3245", total: 62.78,
      message: "Pedido confirmado e encaminhado à loja.",
    });
  };
  try {
    await prepareOrderReceipt({
      sessionId: TENANT, customerJid: JID,
      phone: PHONE, draftId: draft.draftId,
    });
    const files = await readdir(root);
    assert.equal(files.length, 1);
    const encrypted = await readFile(join(root, files[0]), "utf8");
    assert.doesNotMatch(encrypted, /5531999966991|12345678-1234|wa-chat:/);
    // A second store must not receive this customer's receipt.
    assert.equal(await drainOrderReceipts(OTHER_TENANT,
      async () => { throw Error("Wrong store"); }, mockLogger), 0);
    assert.equal(calls.length, 0);
    assert.equal(await drainOrderReceipts(TENANT, async (jid, data) => {
      outbound.push({ jid, text: data.text });
    }, mockLogger), 1);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].jid, JID);
    assert.match(outbound[0].text, /Pedido #3245 confirmado/);
    assert.match(outbound[0].text, /R\$\s*62,78/);
    assert.equal(calls.length, 1);
    assert.equal(calls.some(call => call.action === "commit"), false);
    assert.equal((await readdir(root)).length, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.WHATSAPP_RECEIPT_DIR;
    else process.env.WHATSAPP_RECEIPT_DIR = oldDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared receipt without a matching SQL order never creates or announces an order", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-precommit-no-order-"));
  const oldDir = process.env.WHATSAPP_RECEIPT_DIR;
  const oldFetch = globalThis.fetch;
  process.env.WHATSAPP_RECEIPT_DIR = root;
  let calls = 0, sends = 0;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.action, "receipt");
    calls++;
    return json({ ok: true, found: false });
  };
  try {
    await prepareOrderReceipt({
      sessionId: TENANT, customerJid: JID, phone: PHONE, draftId: draft.draftId,
    });
    assert.equal(await drainOrderReceipts(TENANT, async () => { sends++; }, mockLogger), 0);
    assert.equal(calls, 1);
    assert.equal(sends, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.WHATSAPP_RECEIPT_DIR;
    else process.env.WHATSAPP_RECEIPT_DIR = oldDir;
    await rm(root, { recursive: true, force: true });
  }
});
