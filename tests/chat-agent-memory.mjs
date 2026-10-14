// tests/chat-agent-memory.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.API_KEY = "gateway-test-secret-for-chat-memory";
process.env.GEMINI_API_KEY = "gemini-test-key";
process.env.VERCEL_API_URL = "https://backend.test";
process.env.WHATSAPP_CHAT_ORDERS_ENABLED = "true";

const { loadChatMemory, saveChatMemory } = await import("../dist/chatMemory.js");
const { isStoreQuestion, answerStoreQuestion } = await import("../dist/chatAgent.js");
const { handleChatOrderMessage } = await import("../dist/chatOrder.js");
const PUDIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "22222222-2222-4222-8222-222222222222";
const PHONE = "5531999907788";
const products = [{ id: PUDIM, name: "Pudim", category: "Sobremesas",
  description: "Sobremesa da casa", price: 12, optionGroups: [] }];
const logger = { warn() {}, info() {} };
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

test("natural store questions are distinguished from checkout field replies", () => {
  for (const text of ["Qual é o horário da loja?", "Onde vocês ficam?",
    "Aceita Pix?", "Quanto é a taxa de entrega?", "Quero saber o horário",
    "Me recomenda uma sobremesa?", "Estão abertos agora?"]) {
    assert.equal(isStoreQuestion(text), true, text);
  }
  for (const text of ["Entrega", "Pix", "Cartão", "Retirada", "Quero 2 pudins",
    "Confirmo", "Cancelar pedido", "Quero alterar meu pedido"]) {
    assert.equal(isStoreQuestion(text), false, text);
  }
});

test("seven-day memory is encrypted, scoped to customer and store, and remains readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-chat-memory-"));
  const old = process.env.CHAT_MEMORY_DIR;
  process.env.CHAT_MEMORY_DIR = directory;
  try {
    const turns = [{ role: "user", text: "Meu nome é Joana e moro na Rua das Palmeiras 15" },
      { role: "assistant", text: "Entendi, Joana!" }];
    await saveChatMemory(SESSION, PHONE, turns);
    assert.deepEqual(await loadChatMemory(SESSION, PHONE), turns);
    assert.deepEqual(await loadChatMemory(SESSION, "5531999911111"), []);
    assert.deepEqual(await loadChatMemory("33333333-3333-4333-8333-333333333333", PHONE), []);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const stored = await readFile(join(directory, files[0]), "utf8");
    assert.doesNotMatch(stored, /Joana|Palmeiras|5531999907788/);
  } finally {
    if (old === undefined) delete process.env.CHAT_MEMORY_DIR;
    else process.env.CHAT_MEMORY_DIR = old;
    await rm(directory, { force: true, recursive: true });
  }
});

test("Gemini receives verified store facts, multi-turn context, and no transaction access", async () => {
  const oldFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    requests.push({ url: String(url), body: JSON.parse(opts.body) });
    return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      reply: "Funcionamos de segunda a sábado das 18h às 23h.",
    }) }] } }] });
  };
  try {
    const answer = await answerStoreQuestion({
      text: "E amanhã fecha que horas?",
      history: [{role:"user",text:"Qual o horário da loja?"},
        {role:"assistant",text:"Abrimos às 18h"},
        {role:"user",text:"E amanhã fecha que horas?"}],
      catalog: { menuUrl: "https://menu.test", storeName: "Loja Teste",
        deliveryMode: "neighborhood", products },
      storeInfo: {storeName:"Loja Teste", openingHours:{monday:"18:00-23:00"},
        aiContext:{business:{address:"Avenida Central 25"},
          delivery:{mode:"neighborhood",neighborhoods:[{name:"Centro",fee:5}]}}},
      geminiKey:"gemini-test-key",geminiModel:"gemini-3.1-flash-lite",
      sessionId:SESSION,logger,
    });
    assert.match(answer, /18h às 23h/);
    assert.equal(requests.length, 1);
    const data = JSON.stringify(requests[0].body);
    assert.match(data, /Avenida Central 25/);
    assert.match(data, /Qual o horário da loja/);
    assert.match(data, /Pudim/);
    assert.doesNotMatch(data, /API_KEY|service_role/);
  } finally { globalThis.fetch = oldFetch; }
});

test("WhatsApp answer about business details does not modify or submit the cart", async () => {
  const oldFetch = globalThis.fetch;
  const calls = [], sent = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const body = JSON.parse(opts.body);
      if (body.system_instruction?.parts?.[0]?.text?.includes("Você é um atendente humanoide")) {
        return response({ candidates: [{ content: { parts: [{
          text: JSON.stringify({reply:"A loja fica na Avenida Central 25."}),
        }] } }] });
      }
      return response({error:"temporarily unavailable"},503);
    }
    const req = JSON.parse(opts.body);
    calls.push(req);
    if (req.action === "catalog") return response({
      ok:true,storeName:"Loja Teste",menuUrl:"https://menu.test",deliveryMode:"neighborhood",
      products,
    });
    throw new Error("Unexpected backend write: " + req.action);
  };
  const params = (text) => ({sessionId: SESSION, customerJid: PHONE+"@s.whatsapp.net",
    customerPhone: PHONE, text, logger, sendMessage: async (_jid, body) => sent.push(body.text),
    getStoreInfo: async () => ({storeName:"Loja Teste",aiContext:{
      business:{address:"Avenida Central 25"},
    }}),
  });
  try {
    assert.equal(await handleChatOrderMessage(params("Quero 1 pudim")), true);
    assert.match(sent.at(-1), /Pudim/);
    assert.equal(await handleChatOrderMessage(params("Onde fica a loja?")), true);
    assert.match(sent.at(-1), /Avenida Central 25/);
    assert.equal(await handleChatOrderMessage(params("Retire o pudim por favor")), true);
    assert.match(sent.at(-1), /Retirei.*Pudim/);
    assert.equal(calls.filter(call => call.action === "commit" || call.action === "preview").length, 0);
  } finally { globalThis.fetch = oldFetch; }
});
