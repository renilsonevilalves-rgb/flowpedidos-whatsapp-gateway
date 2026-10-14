// tests/chat-field-agent.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

process.env.API_KEY="field-tests-strong-key";
process.env.CHAT_RECEIPTS_DIR = join(tmpdir(), "wa-receipts-test-" + process.pid);
process.env.GEMINI_API_KEY="field-tests-gemini";
process.env.VERCEL_API_URL="https://backend.test";
process.env.GEMINI_MODEL="test-model";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED="true";
const {handleChatOrderMessage}=await import("../dist/chatOrder.js");
const {saveChatSession,loadChatSession}=await import("../dist/chatMemory.js");
const {looksLikeFieldEdit, replyValue, safeFieldFallback}=await import("../dist/chatFieldAgent.js");
const tenant="22222222-2222-4222-8222-222222222222";
const product="11111111-1111-4111-8111-111111111111";
const logger={warn(){},info(){}};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});
const draft={
  draftId:"12345678-1234-4234-8234-123456789abc",items:[{productId:product,quantity:1,selectedOptions:[],notes:""}],
  name:"Renilson",deliveryType:"delivery",address:"Rua Tereza Cristina",
  number:"1999",neighborhood:"Fonte Grande",complement:"",reference:"",paymentMethod:"money",
};
const catalog={ok:true,storeName:"ReniXBurguer",menuUrl:"https://menu.test",deliveryMode:"neighborhood",
  neighborhoods:["Fonte Grande","Centro"],products:[{id:product,name:"Vitamina de Açaí",price:9.99,optionGroups:[]}]};
const preview={ok:true,quoteToken:"signed.mock.token",expires:Date.now()+600000,
  items:[{name:"Vitamina de Açaí",quantity:1,total:9.99}],
  subtotal:9.99,deliveryFee:3,total:12.99};
test("detect exact screenshot corrections without choosing a new street",()=>{
  for (const input of ["Quero mudar o número do endereço","Quero mudar só o número","O número está errado","Quero corrigir o bairro"]) {
    assert.equal(looksLikeFieldEdit(input),true,input);
  }
  assert.deepEqual(safeFieldFallback("Quero mudar só o número"),{field:"number",value:""});
  assert.equal(replyValue("2001","number"),"2001");
  assert.equal(replyValue("O novo número é 2001","number"),"2001");
  assert.equal(replyValue("quero mudar o número","number"),"");
});

test("screenshot regression: Gemini asks ONLY new number, keeps complete delivery address and requotes",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"wa-number-edit-")),oldDir=process.env.CHAT_MEMORY_DIR;
  process.env.CHAT_MEMORY_DIR=directory;
  const oldFetch=globalThis.fetch,sent=[],calls=[],customer="5531999955091";
  globalThis.fetch=async(url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com")){
      const data=JSON.parse(opts.body);
      assert.match(data.system_instruction.parts[0].text,/coordenador de intenção/);
      return response({candidates:[{content:{parts:[{text:JSON.stringify({field:"number",value:""})}]}}]});
    }
    const req=JSON.parse(opts.body);calls.push(req);
    if(req.action==="catalog")return response(catalog);
    if(req.action==="preview")return response(preview);
    if(req.action==="commit")return response({ok:true,orderNumber:"507",total:12.99,message:"Pedido criado"});
    throw new Error("unexpected action "+req.action);
  };
  const p=text=>({sessionId:tenant,customerPhone:customer,customerJid:customer+"@s.whatsapp.net",
    text,logger,sendMessage:async(_jid,m)=>sent.push(m.text)});
  try {
    await saveChatSession(tenant,customer+"@s.whatsapp.net",[],draft);
    assert.equal(await handleChatOrderMessage(p("Quero mudar o número do endereço")),true);
    assert.match(sent.at(-1),/Qual é o \*novo número\*/);
    assert.match(sent.at(-1),/Rua Tereza Cristina/);
    assert.doesNotMatch(sent.at(-1),/preciso da rua e número/);
    assert.equal(calls.filter(c=>c.action==="preview").length,0);
    await handleChatOrderMessage(p("SIM"));
    assert.match(sent.at(-1),/novo número/);
    assert.equal(calls.filter(c=>c.action==="preview" || c.action==="commit").length,0);
    await handleChatOrderMessage(p("Quero mudar só o número"));
    assert.match(sent.at(-1),/Qual é o \*novo número\*/);
    await handleChatOrderMessage(p("2001"));
    assert.match(sent.at(-1),/Alterei apenas o \*número\* para \*2001\*/);
    assert.match(sent.at(-1),/Rua Tereza Cristina, 2001 — Fonte Grande/);
    const check=calls.filter(c=>c.action==="preview");
    assert.equal(check.length,1);
    assert.equal(check[0].address,"Rua Tereza Cristina");
    assert.equal(check[0].neighborhood,"Fonte Grande");
    assert.equal(check[0].number,"2001");
    assert.equal(check[0].name,"Renilson");
    assert.equal(check[0].paymentMethod,"money");
    assert.equal(check[0].items[0].quantity,1);
    assert.equal(calls.filter(c=>c.action==="commit").length,0);
    await handleChatOrderMessage(p("SIM"));
    assert.equal(calls.filter(c=>c.action==="commit").length,1);
    assert.equal(calls.filter(c=>c.action==="commit")[0].number,"2001");
  } finally {
    globalThis.fetch=oldFetch;
    if(oldDir===undefined)delete process.env.CHAT_MEMORY_DIR;else process.env.CHAT_MEMORY_DIR=oldDir;
    await rm(directory,{recursive:true,force:true});
  }
});
test("pending correction persists encrypted across process restart and cannot confirm outdated quote",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"wa-field-memory-")),oldDir=process.env.CHAT_MEMORY_DIR;
  process.env.CHAT_MEMORY_DIR=directory;
  const oldFetch=globalThis.fetch,sent=[],calls=[],customer="5531999955092";
  globalThis.fetch=async(url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com"))
      return response({candidates:[{content:{parts:[{text:JSON.stringify({field:"number",value:""})}]}}]});
    const req=JSON.parse(opts.body);calls.push(req);
    if(req.action==="catalog")return response(catalog);
    if(req.action==="preview")return response(preview);
    throw Error("Unexpected backend action "+req.action);
  };
  const p=text=>({sessionId:tenant,customerPhone:customer,customerJid:customer+"@s.whatsapp.net",
    text,logger,sendMessage:async(_jid,x)=>sent.push(x.text)});
  try {
    await saveChatSession(tenant,customer+"@s.whatsapp.net",[],draft,"number");
    const recovered=await loadChatSession(tenant,customer+"@s.whatsapp.net");
    assert.equal(recovered.pendingEdit,"number");
    assert.equal(await handleChatOrderMessage(p("207")),true);
    assert.match(sent.at(-1),/Rua Tereza Cristina, 207 — Fonte Grande/);
    const previewCall=calls.find(c=>c.action==="preview");
    assert.equal(previewCall.number,"207");
    assert.equal(previewCall.address,"Rua Tereza Cristina");
    assert.equal((await loadChatSession(tenant,customer+"@s.whatsapp.net")).pendingEdit,null);
  } finally {
    globalThis.fetch=oldFetch;
    if(oldDir===undefined)delete process.env.CHAT_MEMORY_DIR;else process.env.CHAT_MEMORY_DIR=oldDir;
    await rm(directory,{recursive:true,force:true});
  }
});
