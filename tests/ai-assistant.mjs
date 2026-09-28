import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
process.env.VERCEL_API_URL = 'https://backend.test';
process.env.API_KEY = 'test-gateway-key';

const {
  buildAiSystemInstruction,
  extractGeminiText,
  handleAiAssistantMessage,
  normalizePaymentMethod,
  parseAiDecision,
} = await import('../dist/aiAssistant.js');

const logger = { info() {}, warn() {}, error() {} };

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

test('system instruction classifies natural order actions without letting AI execute them', () => {
  const prompt = buildAiSystemInstruction({
    storeName: 'Loja Teste',
    menuUrl: 'https://example.test/cardapio',
    autoReplyMessage: 'Bem-vindo',
  });
  assert.match(prompt, /Loja Teste/);
  assert.match(prompt, /https:\/\/example\.test\/cardapio/);
  assert.match(prompt, /Nunca invente preço/);
  assert.match(prompt, /change_payment/);
  assert.match(prompt, /código do sistema valida telefone, tenant, pedido, etapa e confirmação/);
});

test('extracts and parses structured Gemini decisions safely', () => {
  assert.equal(extractGeminiText({ candidates: [{ content: { parts: [{ text: 'Olá' }, { text: 'Tudo bem?' }] } }] }), 'Olá\nTudo bem?');
  assert.equal(extractGeminiText({}), '');

  assert.deepEqual(parseAiDecision('{"intent":"change_payment","reply":"","paymentMethod":"dinheiro","hasChangeDetails":false}'), {
    intent: 'change_payment',
    reply: '',
    paymentMethod: 'money',
    hasChangeDetails: false,
  });
  assert.equal(normalizePaymentMethod('Cartão de Crédito'), 'credit');
  assert.equal(normalizePaymentMethod('débito'), '');
});

test('assistant sends a general Gemini reply without exposing API key in URL', async () => {
  const originalFetch = globalThis.fetch;
  let sent = null;
  let request = null;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return geminiDecision({
      intent: 'general',
      reply: 'Olá! Confira nosso cardápio aqui: https://example.test/cardapio',
      paymentMethod: '',
      hasChangeDetails: false,
    });
  };
  try {
    const handled = await handleAiAssistantMessage({
      sessionId: 'tenant-general',
      customerJid: '5511999999999@s.whatsapp.net',
      customerPhone: '5511999999999',
      text: 'Oi, quero ver o cardápio',
      getStoreInfo: async () => ({ storeName: 'Loja Teste', menuUrl: 'https://example.test/cardapio' }),
      sendMessage: async (_jid, content) => { sent = content.text; },
      logger,
    });
    assert.equal(handled, true);
    assert.match(sent, /cardápio/i);
    assert.ok(request);
    assert.match(request.url, /gemini-3\.5-flash-lite:generateContent$/);
    assert.equal(request.url.includes('test-gemini-key'), false);
    assert.equal(request.init.headers['x-goog-api-key'], 'test-gemini-key');
    const body = JSON.parse(request.init.body);
    assert.equal(body.generationConfig.maxOutputTokens, 260);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.contents[0].parts[0].text, 'Oi, quero ver o cardápio');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('natural cancellation is classified by Gemini but only executed after explicit confirmation', async () => {
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
        return response(200, { ok: true, orders: [{ id: '11111111-1111-1111-1111-111111111111', orderNumber: '5240', statusLabel: 'novo', totalLabel: 'R$ 50,00' }] });
      }
      if (body.action === 'cancel') {
        cancelCalls += 1;
        return response(200, { ok: true, message: '✅ Pedido #5240 cancelado com sucesso.' });
      }
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const base = {
    sessionId: '22222222-2222-2222-2222-222222222222',
    customerJid: '5511977777777@s.whatsapp.net',
    customerPhone: '5511977777777',
    getStoreInfo: async () => ({ storeName: 'Loja Teste' }),
    sendMessage: async (_jid, content) => { sent.push(content.text); },
    logger,
  };

  try {
    assert.equal(await handleAiAssistantMessage({ ...base, text: 'quero cancelar meu pedido' }), true);
    assert.equal(cancelCalls, 0);
    assert.match(sent.at(-1), /Confirma o cancelamento/i);

    assert.equal(await handleAiAssistantMessage({ ...base, text: 'sim' }), true);
    assert.equal(cancelCalls, 1);
    assert.match(sent.at(-1), /cancelado com sucesso/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('payment change uses the secure payment endpoint only after confirmation', async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  let paymentCalls = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      return geminiDecision({ intent: 'change_payment', reply: '', paymentMethod: 'money', hasChangeDetails: false });
    }
    if (target.endsWith('/api/webhook/whatsapp/order-self-service')) {
      return response(200, { ok: true, orders: [{ id: '33333333-3333-3333-3333-333333333333', orderNumber: '6001', statusLabel: 'em preparo' }] });
    }
    if (target.endsWith('/api/webhook/whatsapp/payment-change')) {
      paymentCalls += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.paymentMethod, 'money');
      return response(200, { ok: true, message: '✅ Forma de pagamento do pedido #6001 alterada para Dinheiro.' });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const base = {
    sessionId: '44444444-4444-4444-4444-444444444444',
    customerJid: '5511966666666@s.whatsapp.net',
    customerPhone: '5511966666666',
    getStoreInfo: async () => ({ storeName: 'Loja Teste' }),
    sendMessage: async (_jid, content) => { sent.push(content.text); },
    logger,
  };

  try {
    assert.equal(await handleAiAssistantMessage({ ...base, text: 'muda o pagamento para dinheiro' }), true);
    assert.equal(paymentCalls, 0);
    assert.match(sent.at(-1), /Confirma alterar o pagamento/i);

    assert.equal(await handleAiAssistantMessage({ ...base, text: 'sim' }), true);
    assert.equal(paymentCalls, 1);
    assert.match(sent.at(-1), /alterada para Dinheiro/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('assistant sends a safe menu fallback on Gemini provider error', async () => {
  const originalFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async () => response(429, { error: { status: 'RESOURCE_EXHAUSTED' } });
  try {
    const handled = await handleAiAssistantMessage({
      sessionId: 'tenant-provider-error',
      customerJid: '5511888888888@s.whatsapp.net',
      customerPhone: '5511888888888',
      text: 'Tem pastel de carne?',
      getStoreInfo: async () => ({ storeName: 'Loja Teste', menuUrl: 'https://example.test/cardapio' }),
      sendMessage: async (_jid, content) => { sent = content.text; },
      logger,
    });
    assert.equal(handled, true);
    assert.match(sent, /Para confirmar se temos esse item disponível agora/i);
    assert.match(sent, /https:\/\/example\.test\/cardapio/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});