import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
process.env.VERCEL_API_URL = 'https://backend.test';
process.env.API_KEY = 'test-gateway-key';

const { handleAiAssistantMessage } = await import('../dist/aiAssistant.js');

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

test('item addition is previewed with unit price and total, can be revised, and only reaches store after SIM', async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  const changeBodies = [];
  let actualChanges = 0;

  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      return geminiDecision({ intent: 'change_order', reply: '', paymentMethod: '', hasChangeDetails: true });
    }

    if (target.endsWith('/api/webhook/whatsapp/order-self-service')) {
      const body = JSON.parse(init.body);
      if (body.action === 'lookup') {
        return response(200, {
          ok: true,
          orders: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', orderNumber: '7001', statusLabel: 'novo', total: 29.99, totalLabel: 'R$ 29,99' }],
        });
      }

      changeBodies.push(body);
      if (body.previewOnly === true) {
        const quantity = /Adicionar 2 Pudim/i.test(body.changeText) ? 2 : 3;
        return response(200, {
          ok: true,
          previewOnly: true,
          customerConfirmationRequired: true,
          changeType: 'add_item',
          orderNumber: '7001',
          itemName: 'Pudim',
          quantityAdded: quantity,
          unitPrice: 29.9,
          addedAmount: quantity * 29.9,
          currentTotal: 29.99,
          proposedTotal: 29.99 + quantity * 29.9,
          canonicalChangeText: `Adicionar ${quantity} Pudim ao meu pedido`,
        });
      }

      actualChanges += 1;
      return response(200, { ok: true, message: '✅ Solicitação enviada à loja para aprovação.' });
    }

    throw new Error(`unexpected URL ${target}`);
  };

  const base = {
    sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    customerJid: '5511955555555@s.whatsapp.net',
    customerPhone: '5511955555555',
    getStoreInfo: async () => ({ storeName: 'Loja Teste' }),
    sendMessage: async (_jid, content) => { sent.push(content.text); },
    logger,
  };

  try {
    assert.equal(await handleAiAssistantMessage({ ...base, text: 'tem como adicionar 3 pudim?' }), true);
    assert.equal(actualChanges, 0);
    assert.equal(changeBodies.at(-1).previewOnly, true);
    assert.match(sent.at(-1), /3/);
    assert.match(sent.at(-1), /R\$\s*29,90/);
    assert.match(sent.at(-1), /R\$\s*89,70/);
    assert.match(sent.at(-1), /R\$\s*29,99/);
    assert.match(sent.at(-1), /R\$\s*119,69/);
    assert.match(sent.at(-1), /Confirma essa alteração/i);
    assert.match(sent.at(-1), /loja ainda não recebeu/i);

    assert.equal(await handleAiAssistantMessage({ ...base, text: 'quero só 2' }), true);
    assert.equal(actualChanges, 0);
    assert.equal(changeBodies.at(-1).previewOnly, true);
    assert.equal(changeBodies.at(-1).changeText, 'Adicionar 2 Pudim ao meu pedido');
    assert.match(sent.at(-1), /Quantidade: \*2\*/i);
    assert.match(sent.at(-1), /R\$\s*59,80/);
    assert.match(sent.at(-1), /R\$\s*89,79/);

    assert.equal(await handleAiAssistantMessage({ ...base, text: 'sim' }), true);
    assert.equal(actualChanges, 1);
    assert.equal(changeBodies.at(-1).previewOnly, undefined);
    assert.equal(changeBodies.at(-1).changeText, 'Adicionar 2 Pudim ao meu pedido');
    assert.match(sent.at(-1), /enviada à loja/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('customer can abandon a preview without sending any change to the store', async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  let actualChanges = 0;

  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('generativelanguage.googleapis.com')) {
      return geminiDecision({ intent: 'change_order', reply: '', paymentMethod: '', hasChangeDetails: true });
    }
    if (target.endsWith('/api/webhook/whatsapp/order-self-service')) {
      const body = JSON.parse(init.body);
      if (body.action === 'lookup') {
        return response(200, { ok: true, orders: [{ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', orderNumber: '7002', statusLabel: 'novo', totalLabel: 'R$ 20,00' }] });
      }
      if (body.previewOnly === true) {
        return response(200, {
          ok: true,
          previewOnly: true,
          changeType: 'add_item',
          itemName: 'Pudim',
          quantityAdded: 1,
          unitPrice: 29.9,
          addedAmount: 29.9,
          currentTotal: 20,
          proposedTotal: 49.9,
          canonicalChangeText: 'Adicionar 1 Pudim ao meu pedido',
        });
      }
      actualChanges += 1;
      return response(200, { ok: true });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  const base = {
    sessionId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    customerJid: '5511944444444@s.whatsapp.net',
    customerPhone: '5511944444444',
    getStoreInfo: async () => ({ storeName: 'Loja Teste' }),
    sendMessage: async (_jid, content) => { sent.push(content.text); },
    logger,
  };

  try {
    assert.equal(await handleAiAssistantMessage({ ...base, text: 'adicionar 1 pudim' }), true);
    assert.equal(actualChanges, 0);
    assert.equal(await handleAiAssistantMessage({ ...base, text: 'não' }), true);
    assert.equal(actualChanges, 0);
    assert.match(sent.at(-1), /não foi enviada à loja/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
