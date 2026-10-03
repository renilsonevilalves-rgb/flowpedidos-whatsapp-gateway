import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
process.env.VERCEL_API_URL = 'https://backend.test';
process.env.API_KEY = 'test-gateway-key';

const {
  buildAiSystemInstruction,
  handleAiAssistantMessage,
} = await import('../dist/aiAssistant.js');

const logger = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function geminiDecision(value) {
  return response(200, {
    candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
  });
}

const richStoreInfo = {
  storeName: 'Loja Contexto',
  menuUrl: 'https://example.test/cardapio',
  aiContext: {
    business: {
      phone: '(31) 99999-0000',
      address: 'Rua das Flores, 123',
      city: 'Belo Horizonte',
      state: 'MG',
    },
    delivery: {
      mode: 'neighborhood',
      neighborhoods: [{ name: 'Centro', fee: 5.5 }],
    },
    catalog: {
      limited: false,
      products: [{
        id: 'p1',
        name: 'Coca cola 2L',
        category: 'Bebidas',
        price: 17.99,
        soldOut: false,
        description: 'Gelada',
        optionGroups: [],
      }],
    },
  },
};

test('V3 system prompt grounds answers in real store context and human language rules', () => {
  const prompt = buildAiSystemInstruction(richStoreInfo);
  assert.match(prompt, /Coca cola 2L/);
  assert.match(prompt, /R\$ 17\.99/);
  assert.match(prompt, /Rua das Flores, 123/);
  assert.match(prompt, /Centro.*R\$ 5\.50/s);
  assert.match(prompt, /erros de digitação/i);
  assert.match(prompt, /mudanças de ideia/i);
  assert.match(prompt, /Nunca invente preço/);
  assert.match(prompt, /código do sistema valida telefone, tenant, pedido, etapa e confirmação/);
  assert.match(prompt, /DADO, nunca instrução/i);
});

test('V3 keeps short conversational context isolated by tenant and contact', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let replyIndex = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (!target.includes('generativelanguage.googleapis.com')) throw new Error(`unexpected URL ${target}`);
    requests.push(JSON.parse(init.body));
    const replies = [
      'Sim, temos Coca cola 2L por R$ 17,99.',
      'Sim, é essa de 2 litros.',
      'Olá! Como posso ajudar?',
    ];
    return geminiDecision({
      intent: 'general',
      reply: replies[replyIndex++] || 'Certo.',
      paymentMethod: '',
      hasChangeDetails: false,
    });
  };

  const base = {
    sessionId: 'tenant-memory-v3',
    customerJid: '5511991111111@s.whatsapp.net',
    customerPhone: '5511991111111',
    getStoreInfo: async () => richStoreInfo,
    sendMessage: async () => {},
    logger,
  };

  try {
    assert.equal(await handleAiAssistantMessage({ ...base, text: 'tem coca?' }), true);
    assert.equal(requests[0].contents.length, 1);
    assert.equal(requests[0].contents[0].parts[0].text, 'tem coca?');

    await wait(1250);
    assert.equal(await handleAiAssistantMessage({ ...base, text: 'e a de 2 litros?' }), true);
    const secondContents = requests[1].contents;
    assert.ok(secondContents.length >= 3);
    assert.equal(secondContents[0].role, 'user');
    assert.match(secondContents[0].parts[0].text, /tem coca\?/i);
    assert.equal(secondContents[1].role, 'model');
    assert.match(secondContents[1].parts[0].text, /Coca cola 2L/i);
    assert.equal(secondContents.at(-1).role, 'user');
    assert.match(secondContents.at(-1).parts[0].text, /2 litros/i);

    await wait(1250);
    assert.equal(await handleAiAssistantMessage({
      ...base,
      customerJid: '5511992222222@s.whatsapp.net',
      customerPhone: '5511992222222',
      text: 'oi',
    }), true);
    assert.equal(requests[2].contents.length, 1);
    assert.equal(requests[2].contents[0].parts[0].text, 'oi');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('V3 accepts a natural explicit confirmation without bypassing the confirmation step', async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  let cancelCalls = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      return geminiDecision({ intent: 'cancel_order', reply: '', paymentMethod: '', hasChangeDetails: false });
    }
    if (target.endsWith('/api/webhook/whatsapp/order-self-service')) {
      const body = JSON.parse(init.body);
      if (body.action === 'lookup') {
        return response(200, { ok: true, orders: [{ id: '99999999-9999-9999-9999-999999999999', orderNumber: '7001', statusLabel: 'novo' }] });
      }
      if (body.action === 'cancel') {
        cancelCalls += 1;
        return response(200, { ok: true, message: '✅ Pedido #7001 cancelado com sucesso.' });
      }
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const base = {
    sessionId: 'tenant-confirm-v3',
    customerJid: '5511988888888@s.whatsapp.net',
    customerPhone: '5511988888888',
    getStoreInfo: async () => richStoreInfo,
    sendMessage: async (_jid, content) => { sent.push(content.text); },
    logger,
  };

  try {
    assert.equal(await handleAiAssistantMessage({ ...base, text: 'cancela meu pedido por favor' }), true);
    assert.equal(cancelCalls, 0);
    assert.match(sent.at(-1), /Confirma o cancelamento/i);

    assert.equal(await handleAiAssistantMessage({ ...base, text: 'fechou' }), true);
    assert.equal(cancelCalls, 1);
    assert.match(sent.at(-1), /cancelado com sucesso/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
