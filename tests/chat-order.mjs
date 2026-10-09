// tests/chat-order.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";
process.env.GEMINI_API_KEY = "fake-test-gemini";
process.env.GEMINI_MODEL = "test-gemini";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.API_KEY = "fake-test-backend-key";

const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const logger = { info() {}, warn() {} };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function params(id, text, messages) {
  return {
    sessionId: "22222222-2222-4222-8222-222222222222",
    customerJid: id + "@s.whatsapp.net",
    customerPhone: id,
    text, logger,
    sendMessage: async (_jid, item) => { messages.push(item.text); },
  };
}

test("collects items, asks for missing fields and commits only after explicit confirmation", async () => {
  const messages = [];
  const calls = [];
  const originalFetch = globalThis.fetch;
  const draft = { items: [{ productId: PRODUCT, quantity: 2, notes: "Sem cebola", selectedOptions: [] }],
    name: "", deliveryType: "", address: "", number: "", neighborhood: "", complement: "", reference: "", paymentMethod: "" };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const text = body.contents[0].parts[0].text;
      if (text.endsWith("retirada")) draft.deliveryType = "pickup";
      if (text.endsWith("Maria")) draft.name = "Maria";
      if (text.endsWith("Pix online")) draft.paymentMethod = "online_pix";
      return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({ draft }) }] } }] });
    }
    calls.push(body);
    if (body.action === "catalog") return response({
      ok: true, menuUrl: "https://menu.test", deliveryMode: "neighborhood",
      products: [{ id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] }],
    });
    if (body.action === "preview") return response({ ok: true, quoteToken: "signed.mock.token", expires: Date.now() + 60000,
      items: [{ name: "X Tudo", quantity: 2, total: 50, notes: "Sem cebola" }], subtotal: 50, deliveryFee: 0, total: 50 });
    if (body.action === "commit") return response({ ok: true, orderNumber: "5123", total: 50,
      message: "Aguardando pagamento online.", paymentUrl: "https://menu.test/pay/123" });
    throw new Error("unexpected request");
  };
  try {
    const id = "5531999988877";
    assert.equal(await handleChatOrderMessage(params(id, "quero 2 X Tudo sem cebola", messages)), true);
    assert.match(messages.at(-1), /entrega.*retirada/i);
    assert.match(messages.at(-1), /Anotei seu pedido:\n2x X Tudo \(Sem cebola\)/);
    assert.equal(calls.filter((c) => c.action === "commit").length, 0);
    await handleChatOrderMessage(params(id, "retirada", messages));
    assert.match(messages.at(-1), /nome/i);
    await handleChatOrderMessage(params(id, "Maria", messages));
    assert.match(messages.at(-1), /pagar/i);
    await handleChatOrderMessage(params(id, "Pix online", messages));
    assert.match(messages.at(-1), /Confira seu pedido/i);
    assert.match(messages.at(-1), /\nSubtotal:/);
    assert.match(messages.at(-1), /\nTotal:/);
    assert.equal(calls.filter((c) => c.action === "commit").length, 0);
    assert.equal(calls.find((c) => c.action === "preview").items[0].notes, "Sem cebola");
    await handleChatOrderMessage(params(id, "SIM", messages));
    assert.equal(calls.filter((c) => c.action === "commit").length, 1);
    assert.match(messages.at(-1), /menu.test\/pay\/123/);
  } finally { globalThis.fetch = originalFetch; }
});

test("never intercepts existing-order changes or tracking", async () => {
  const messages = [];
  assert.equal(await handleChatOrderMessage(params("5531999966611", "quero alterar meu pedido", messages)), false);
  assert.equal(await handleChatOrderMessage(params("5531999966611", "acompanhar meu pedido", messages)), false);
  assert.equal(messages.length, 0);
});

test("feature respects backend deny-by-default and leaves legacy AI available", async () => {
  const messages = [];
  const old = globalThis.fetch;
  globalThis.fetch = async () => response({ ok: false, error: "Não habilitado." }, 403);
  try {
    assert.equal(await handleChatOrderMessage(params("5531999977711", "pedido pelo chat", messages)), false);
    assert.equal(messages.length, 0);
  } finally { globalThis.fetch = old; }
});


test("new-order checkout defers existing-order cancellation while the draft remains open", async () => {
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const input = JSON.parse(options.body).contents[0].parts[0].text;
      const deliveryType = input.endsWith("retirada") ? "pickup" : "";
      return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        draft: { items: [{ productId: PRODUCT, quantity: 1, notes: "", selectedOptions: [] }],
          name: "", deliveryType, address: "", number: "", neighborhood: "", complement: "", reference: "", paymentMethod: "" },
      }) }] } }] });
    }
    return response({ ok: true, menuUrl: "https://menu.test", deliveryMode: "neighborhood",
      products: [{ id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] }] });
  };
  try {
    const id = "5531999944433";
    assert.equal(await handleChatOrderMessage(params(id, "quero um X Tudo", sent)), true);
    assert.match(sent.at(-1), /entrega.*retirada/i);
    const before = sent.length;
    assert.equal(await handleChatOrderMessage(params(id, "quero cancelar meu pedido antigo", sent)), false);
    assert.equal(sent.length, before);
    assert.equal(await handleChatOrderMessage(params(id, "retirada", sent)), true);
    assert.match(sent.at(-1), /nome/i);
  } finally { globalThis.fetch = originalFetch; }
});


test("accepts natural request to start an order without forcing a menu", async () => {
  const messages = [];
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com"))
      return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        draft: { items: [], name: "", deliveryType: "", address: "", number: "", neighborhood: "",
          complement: "", reference: "", paymentMethod: "" },
      }) }] } }] });
    const body = JSON.parse(options.body);
    calls.push(body.action);
    return response({ ok: true, menuUrl: "https://menu.test", deliveryMode: "neighborhood",
      products: [{ id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] }] });
  };
  try {
    assert.equal(await handleChatOrderMessage(params("5531999911122", "Oi, quero fazer um pedido", messages)), true);
    assert.deepEqual(calls, ["catalog"]);
    assert.match(messages.at(-1), /produtos e quantidades/i);
    assert.equal(messages.at(-1).includes("\n"), false);
  } finally { globalThis.fetch = originalFetch; }
});


test("real WhatsApp screenshot: X-Tudo Turbo and Dell Valle Uva are recognized without Gemini timeout", async () => {
  const messages = [], calls = [];
  const originalFetch = globalThis.fetch;
  const TURBO = "9354a916-e4e0-4c85-aaf4-7a5106191952";
  const UVA = "88b0de4e-b457-4cc0-be66-f31aff3d6985";
  const products = [
    {id: TURBO, name:"X- Tudo Turbo", price:34.90, optionGroups:[]},
    {id: UVA, name:"Dell Vale Uva 1L", price:14.00, optionGroups:[]},
  ];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) throw Error("Gemini unavailable");
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.action === "catalog") return response({ok:true,menuUrl:"https://menu.test",deliveryMode:"neighborhood",products});
    if (body.action === "preview") return response({ok:true,quoteToken:"signed.test",expires:Date.now()+300000,
      items:body.items.map(item=>({quantity:item.quantity,name:products.find(p=>p.id===item.productId).name,total:products.find(p=>p.id===item.productId).price})),
      total:48.90,subtotal:48.90,deliveryFee:0});
    if (body.action === "commit") return response({ok:true,orderNumber:"9012",total:48.90,message:"Pedido confirmado",paymentUrl:null});
    throw Error("Unexpected request "+body.action);
  };
  try {
    const id="5531999912020";
    assert.equal(await handleChatOrderMessage(params(id,"Olá quero pedir um X tudo turbo e um Dell vale de uva",messages)),true);
    assert.match(messages.at(-1),/1x X- Tudo Turbo\n1x Dell Vale Uva 1L/);
    assert.match(messages.at(-1),/nome.*entrega.*retirada/i);
    assert.equal(calls.length,1,"a first message must only fetch catalog");
    await handleChatOrderMessage(params(id,"retirada",messages));
    await handleChatOrderMessage(params(id,"Maria",messages));
    await handleChatOrderMessage(params(id,"Pix na entrega",messages));
    const preview=calls.find(v=>v.action==="preview");
    assert.ok(preview,"must prepare a server-validated quote");
    assert.deepEqual(preview.items.map(i=>[i.productId,i.quantity]),[[TURBO,1],[UVA,1]]);
    assert.match(messages.at(-1),/Total: \*R\$\s+48,90\*/);
    assert.equal(calls.some(v=>v.action==="commit"),false,"no order before explicit confirmation");
    await handleChatOrderMessage(params(id,"SIM",messages));
    assert.equal(calls.filter(v=>v.action==="commit").length,1);
    assert.match(messages.at(-1),/Pedido #9012/);
  } finally {globalThis.fetch=originalFetch;}
});

test("follow-up product text recovers an empty draft after a Gemini timeout", async () => {
  const old=globalThis.fetch, messages=[];
  const products=[
    {id:"9354a916-e4e0-4c85-aaf4-7a5106191952",name:"X- Tudo Turbo",price:34.9,optionGroups:[]},
    {id:"88b0de4e-b457-4cc0-be66-f31aff3d6985",name:"Dell Vale Uva 1L",price:14,optionGroups:[]},
  ];
  globalThis.fetch=async(url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com")) return response({error:"provider unavailable"},503);
    const body=JSON.parse(opts.body);
    if(body.action==="catalog") return response({ok:true,products,menuUrl:"https://menu.test",deliveryMode:"neighborhood"});
    throw Error("unexpected");
  };
  try {
    const id="5531999922122";
    await handleChatOrderMessage(params(id,"Quero fazer um pedido pelo chat",messages));
    assert.match(messages.at(-1),/produtos e quantidades/i);
    await handleChatOrderMessage(params(id,"Um X tudo e um suco Dell vale",messages));
    assert.match(messages.at(-1),/1x X- Tudo Turbo\n1x Dell Vale Uva 1L/);
  }finally{globalThis.fetch=old;}
});

test("ambiguous brand with two sizes cannot be silently selected without Gemini", async () => {
  const originalFetch=globalThis.fetch, messages=[], backendCalls=[];
  globalThis.fetch=async(url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com")) return response({error:"unavailable"},503);
    const body=JSON.parse(opts.body);
    backendCalls.push(body.action);
    return response({ok:true,menuUrl:"https://menu.test",deliveryMode:"neighborhood",products:[
      {id:"11111111-1111-4111-8111-111111111111",name:"Coca Cola 350ml",price:5,optionGroups:[]},
      {id:"22222222-2222-4222-8222-222222222222",name:"Coca Cola 2L",price:15,optionGroups:[]},
    ]});
  };
  try {
    await handleChatOrderMessage(params("5531999923111","Quero uma coca cola",messages));
    assert.equal(backendCalls.includes("preview"),false);
    assert.match(messages.at(-1),/tamanho ou sabor exato/i);
  }finally{globalThis.fetch=originalFetch;}
});


test("handles 2x quantities while refusing an unknown extra product", async () => {
  const prev=globalThis.fetch, messages=[];
  const x="9354a916-e4e0-4c85-aaf4-7a5106191952", actions=[];
  globalThis.fetch=async (url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com")) return response({error:"unavailable"},503);
    const body=JSON.parse(opts.body);
    actions.push(body.action);
    return response({ok:true,menuUrl:"https://menu.test",deliveryMode:"neighborhood",
      products:[{id:x,name:"X- Tudo Turbo",price:34.9,optionGroups:[]}]});
  };
  try{
    await handleChatOrderMessage(params("5531999933001","Quero 2x X Tudo Turbo",messages));
    assert.match(messages.at(-1),/2x X- Tudo Turbo/);
    const other="5531999933002";
    await handleChatOrderMessage(params(other,"Quero um X Tudo Turbo e uma pizza",messages));
    assert.equal(actions.includes("preview"),false);
    assert.match(messages.at(-1),/produtos e quantidades/i);
  }finally{globalThis.fetch=prev;}
});


test("photo reproduction: name + delivery and bairro BEFORE street on separate WhatsApp lines", async () => {
  const originalFetch=globalThis.fetch, messages=[], calls=[];
  const turbo="9354a916-e4e0-4c85-aaf4-7a5106191952", pudim="bce9773d-9d45-4cda-ba1c-f3fc48dfaf48";
  const products=[
    {id:turbo,name:"X- Tudo Turbo",price:34.90,optionGroups:[]},
    {id:pudim,name:"Pudim",price:27.89,optionGroups:[]},
  ];
  globalThis.fetch=async (url, opts) => {
    if (String(url).includes("generativelanguage.googleapis.com")) return response({error:"Gemini timeout"},503);
    const body=JSON.parse(opts.body);calls.push(body);
    if(body.action==="catalog") return response({ok:true,products,neighborhoods:["Bernardo monteiro","Fonte grande"],deliveryMode:"neighborhood",menuUrl:"https://menu.test"});
    if(body.action==="preview") return response({ok:true,quoteToken:"signed.draft",expires:Date.now()+300000,
      subtotal:62.79,deliveryFee:2,total:64.79,
      items:[{name:"X- Tudo Turbo",quantity:1,total:34.90},{name:"Pudim",quantity:1,total:27.89}]});
    if(body.action==="commit") return response({ok:true,orderNumber:"9044",total:64.79,message:"Registrado",paymentUrl:"https://menu.test/payment"});
    throw Error("Unexpected call: "+body.action);
  };
  try {
    const id="5531999913344";
    await handleChatOrderMessage(params(id,"Olá queria um X tudo turbo e um pudim",messages));
    assert.match(messages.at(-1),/1x X- Tudo Turbo\n1x Pudim/);
    await handleChatOrderMessage(params(id,"Renilson\nPrefiro entrega",messages));
    assert.match(messages.at(-1),/rua, número e bairro/i);
    await handleChatOrderMessage(params(id,"Bernardo monteiro\nRua Tereza Cristina 122",messages));
    assert.match(messages.at(-1),/Como prefere \*pagar\*/);
    await handleChatOrderMessage(params(id,"Pix online",messages));
    const preview=calls.find(c=>c.action==="preview");
    assert.ok(preview,"must reach backend preview after complete address");
    assert.equal(preview.name,"renilson");
    assert.equal(preview.deliveryType,"delivery");
    assert.match(preview.address,/Rua Tereza Cristina/i);
    assert.equal(preview.number,"122");
    assert.equal(preview.neighborhood,"Bernardo monteiro");
    assert.equal(preview.paymentMethod,"online_pix");
    assert.equal(calls.filter(c=>c.action==="commit").length,0);
    await handleChatOrderMessage(params(id,"SIM",messages));
    assert.equal(calls.filter(c=>c.action==="commit").length,1);
  } finally {globalThis.fetch=originalFetch;}
});

test("address with street first and bairro last is recognized without Gemini", async () => {
  const originalFetch=globalThis.fetch,messages=[],calls=[];
  globalThis.fetch=async (url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com")) return response({error:"unavailable"},503);
    const body=JSON.parse(opts.body);calls.push(body);
    return response({ok:true,menuUrl:"https://menu.test",deliveryMode:"neighborhood",
      neighborhoods:["Bernardo monteiro","Santo antonio"],
      products:[{id:PRODUCT,name:"X Tudo",price:25,optionGroups:[]}]});
  };
  try {
    const id="5531999913355";
    await handleChatOrderMessage(params(id,"Quero um X Tudo",messages));
    await handleChatOrderMessage(params(id,"Maria prefiro entrega",messages));
    await handleChatOrderMessage(params(id,"Rua Tereza Cristina, 122 - Bairro Bernardo monteiro",messages));
    assert.match(messages.at(-1),/Como prefere \*pagar\*/);
    assert.equal(calls.filter(c=>c.action==="preview").length,0);
  } finally {globalThis.fetch=originalFetch;}
});

test("partial address asks only for the missing parts, not the same full address again", async () => {
  const originalFetch=globalThis.fetch,messages=[];
  globalThis.fetch=async (url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com")) return response({error:"unavailable"},503);
    return response({ok:true,menuUrl:"https://menu.test",deliveryMode:"neighborhood",
      neighborhoods:["Bernardo monteiro"],
      products:[{id:PRODUCT,name:"X Tudo",price:25,optionGroups:[]}]});
  };
  try {
    const id="5531999913366";
    await handleChatOrderMessage(params(id,"Quero um X Tudo",messages));
    await handleChatOrderMessage(params(id,"Renilson prefiro entrega",messages));
    await handleChatOrderMessage(params(id,"Bairro Bernardo monteiro",messages));
    assert.match(messages.at(-1),/Bairro anotado/);
    await handleChatOrderMessage(params(id,"Rua Tereza Cristina, 122",messages));
    assert.match(messages.at(-1),/Como prefere \*pagar\*/);
  } finally {globalThis.fetch=originalFetch;}
});

test("never infer Turbo automatically from an unspecified bacon variant", async () => {
  const originalFetch=globalThis.fetch,messages=[],calls=[];
  globalThis.fetch=async(url,opts)=>{
    if(String(url).includes("generativelanguage.googleapis.com")) return response({error:"unavailable"},503);
    const body=JSON.parse(opts.body);calls.push(body);
    return response({ok:true,menuUrl:"https://menu.test",deliveryMode:"neighborhood",
      products:[
        {id:"9354a916-e4e0-4c85-aaf4-7a5106191952",name:"X- Tudo Turbo",price:34.9,optionGroups:[]},
        {id:"254c9acd-6471-4978-a409-ad475e985552",name:"X-Egg Bacon",price:25,optionGroups:[]},
        {id:"bce9773d-9d45-4cda-ba1c-f3fc48dfaf48",name:"Pudim",price:27.89,optionGroups:[]},
      ]});
  };
  try {
    await handleChatOrderMessage(params("5531999913377","Olá queria um X tudo de bacon e um pudim",messages));
    assert.equal(calls.filter(x=>x.action==="preview").length,0);
    assert.doesNotMatch(messages.at(-1),/Anotei seu pedido:\n1x X- Tudo Turbo/);
  } finally {globalThis.fetch=originalFetch;}
});


test("offline fallback understands one-letter typo only for a uniquely specified product", async () => {
  const old = globalThis.fetch, messages = [], calls = [];
  const turbo = "9354a916-e4e0-4c85-aaf4-7a5106191952";
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) return response({ error: "unavailable" }, 503);
    const body = JSON.parse(options.body); calls.push(body);
    return response({ ok: true, menuUrl: "https://menu.test", deliveryMode: "neighborhood", products: [
      { id: turbo, name: "X Tudo Turbo", price: 34.90, optionGroups: [] },
      { id: "254c9acd-6471-4978-a409-ad475e985552", name: "X Egg Bacon", price: 25, optionGroups: [] },
    ] });
  };
  try {
    await handleChatOrderMessage(params("5531999900001", "Quero 2 X Tudo Turbu", messages));
    assert.match(messages.at(-1), /2x X Tudo Turbo/);
    assert.equal(calls.filter(x => x.action === "commit").length, 0);
    assert.equal(calls.length, 1, "simple typo must not need Gemini or create an order");
  } finally { globalThis.fetch = old; }
});

test("one long natural message retains product, name, delivery, street, bairro and payment on Gemini outage", async () => {
  const old = globalThis.fetch, messages = [], calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) return response({ error: "outage" }, 503);
    const body = JSON.parse(options.body); calls.push(body);
    if (body.action === "catalog") return response({ ok: true, menuUrl: "https://menu.test",
      deliveryMode: "neighborhood", neighborhoods: ["Centro", "Santa Luzia"],
      products: [{ id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] }] });
    if (body.action === "preview") return response({ ok: true, quoteToken: "signed", expires: Date.now() + 60000,
      items: [{ name: "X Tudo", quantity: 1, total: 25 }], subtotal: 25, deliveryFee: 4, total: 29 });
    if (body.action === "commit") return response({ ok: true, orderNumber: "6052", total: 29, message: "Registrado" });
    throw Error("unexpected backend action " + body.action);
  };
  try {
    const phone = "5531999900002";
    await handleChatOrderMessage(params(phone, "Quero um X Tudo, me chamo Joana, pra entregar Rua Tereza Cristina 122, bairro Centro, pix na entrega", messages));
    const preview = calls.find(x => x.action === "preview");
    assert.ok(preview, "must retain all fields instead of silently skipping mixed intents");
    assert.equal(preview.name, "Joana");
    assert.equal(preview.deliveryType, "delivery");
    assert.equal(preview.number, "122");
    assert.equal(preview.neighborhood, "Centro");
    assert.equal(preview.paymentMethod, "pix");
    assert.match(messages.at(-1), /Confira seu pedido/);
    assert.equal(calls.filter(x => x.action === "commit").length, 0);
    await handleChatOrderMessage(params(phone, "Tá certinho", messages));
    assert.equal(calls.filter(x => x.action === "commit").length, 1);
  } finally { globalThis.fetch = old; }
});

test("bare Pix asks ONLY online vs delivery and understands a one-word answer offline", async () => {
  const old = globalThis.fetch, messages = [], calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) return response({ error: "outage" }, 503);
    const body = JSON.parse(options.body); calls.push(body);
    if (body.action === "catalog") return response({ ok: true, menuUrl: "https://menu.test",
      deliveryMode: "neighborhood", products: [{ id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] }] });
    if (body.action === "preview") return response({ ok: true, quoteToken: "signed", expires: Date.now() + 60000,
      items: [{ name: "X Tudo", quantity: 1, total: 25 }], subtotal: 25, deliveryFee: 0, total: 25 });
    throw Error("unexpected backend action " + body.action);
  };
  try {
    const phone = "5531999900003";
    await handleChatOrderMessage(params(phone, "Quero um X Tudo", messages));
    await handleChatOrderMessage(params(phone, "retirada", messages));
    await handleChatOrderMessage(params(phone, "Maria", messages));
    await handleChatOrderMessage(params(phone, "pix", messages));
    assert.match(messages.at(-1), /Pix.*online.*na entrega/i);
    assert.equal(calls.filter(x => x.action === "preview").length, 0);
    await handleChatOrderMessage(params(phone, "online", messages));
    assert.equal(calls.find(x => x.action === "preview")?.paymentMethod, "online_pix");
    assert.match(messages.at(-1), /Confira seu pedido/);
  } finally { globalThis.fetch = old; }
});

test("mixed cart changes + payment use Gemini WITH prior conversation context", async () => {
  const old = globalThis.fetch, messages = [], calls = [], geminiPrompts = [];
  const dessert = "33333333-3333-4333-8333-333333333333";
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const prompt = body.contents[0].parts[0].text; geminiPrompts.push(prompt);
      return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({ draft: {
        items: [
          { productId: PRODUCT, quantity: 1, selectedOptions: [] },
          { productId: dessert, quantity: 1, selectedOptions: [] },
        ], name: "", deliveryType: "", address: "", number: "", neighborhood: "",
        complement: "", reference: "", paymentMethod: "online_pix",
      } }) }] } }] });
    }
    calls.push(body);
    if (body.action === "catalog") return response({ ok: true, menuUrl: "https://menu.test",
      deliveryMode: "neighborhood", products: [
        { id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] },
        { id: dessert, name: "Pudim", price: 10, optionGroups: [] },
      ] });
    throw Error("unexpected backend action " + body.action);
  };
  try {
    const phone = "5531999900004";
    await handleChatOrderMessage(params(phone, "Quero um X Tudo", messages));
    await handleChatOrderMessage(params(phone, "Acrescenta um pudim e pagar pix online", messages));
    assert.ok(geminiPrompts.length > 0);
    assert.match(geminiPrompts.at(-1), /Conversa recente/);
    assert.match(geminiPrompts.at(-1), /Quero um X Tudo/);
    assert.match(messages.at(-1), /nome.*entrega.*retirada/i);
    assert.equal(calls.filter(x => x.action === "commit").length, 0);
  } finally { globalThis.fetch = old; }
});

test("Gemini cannot guess between similar sizes or sneak in invalid catalog options", async () => {
  const old = globalThis.fetch, messages = [], calls = [];
  const first = "44444444-4444-4444-8444-444444444444";
  const second = "55555555-5555-4555-8555-555555555555";
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes("generativelanguage.googleapis.com")) return response({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ draft: {
        items: [{ productId: first, quantity: 1, selectedOptions: [] }],
        name: "Joana", deliveryType: "pickup", address: "", number: "", neighborhood: "",
        complement: "", reference: "", paymentMethod: "money",
      } }) }] } }],
    });
    calls.push(body);
    return response({ ok: true, menuUrl: "https://menu.test", deliveryMode: "neighborhood",
      products: [
        { id: first, name: "Coca Cola 350ml", price: 5, optionGroups: [] },
        { id: second, name: "Coca Cola 2L", price: 15, optionGroups: [] },
      ] });
  };
  try {
    await handleChatOrderMessage(params("5531999900005", "Quero uma Coca Cola", messages));
    assert.match(messages.at(-1), /tamanho ou sabor exato/i);
    assert.equal(calls.filter(x => x.action === "preview" || x.action === "commit").length, 0);
  } finally { globalThis.fetch = old; }
});


test("after asking for a name, a short name response works even if Gemini is down", async () => {
  const old = globalThis.fetch, messages = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) return response({ error: "outage" }, 503);
    return response({ ok: true, menuUrl: "https://menu.test", deliveryMode: "neighborhood",
      products: [{ id: PRODUCT, name: "X Tudo", price: 25, optionGroups: [] }] });
  };
  try {
    const phone = "5531999900006";
    await handleChatOrderMessage(params(phone, "Quero um X Tudo", messages));
    await handleChatOrderMessage(params(phone, "Maria", messages));
    assert.match(messages.at(-1), /Maria.*entrega.*retirada/i);
    await handleChatOrderMessage(params(phone, "retirada", messages));
    assert.match(messages.at(-1), /Como prefere \*pagar\*/i);
    assert.doesNotMatch(messages.at(-1), /nome/i);
  } finally { globalThis.fetch = old; }
});
