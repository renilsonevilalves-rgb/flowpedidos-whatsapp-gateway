import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'gemini-test';
process.env.GEMINI_FALLBACK_MODEL = 'gemini-test-fallback';
process.env.VERCEL_API_URL = 'https://backend.test';
process.env.API_KEY = 'backend-key';

const { handleAiAssistantMessage } = await import('../dist/aiAssistantV2.js');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function geminiPayload(value) {
  return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
}

function baseParams(customerJid, text, sent) {
  return {
    sessionId: 'tenant-test',
    customerJid,
    customerPhone: '5531999999999',
    text,
    getStoreInfo: async () => ({ storeName: 'Loja Teste', menuUrl: 'https://menu.test' }),
    sendMessage: async (_jid, content) => { sent.push(content.text); },
    logger: { info() {}, warn() {}, error() {} },
  };
}

test('combined replacement is understood as a structured plan, can be revised naturally, and only commits after SIM', async () => {
  const sent = [];
  const backendBodies = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const body = options.body ? JSON.parse(options.body) : {};

    if (target.includes('generativelanguage.googleapis.com')) {
      const userText = body?.contents?.[0]?.parts?.[0]?.text || '';
      if (/tirar o hamb.rguer e adicionar uma coca cola 2l/i.test(userText)) {
        return geminiPayload({
          isOrderChange: true,
          action: 'propose',
          plan: { operations: [
            { action: 'remove_item', product: 'hambúrguer', quantity: 1 },
            { action: 'add_item', product: 'coca cola 2l', quantity: 1 },
          ] },
          reply: '',
        });
      }
      if (/conseguiu tirar o hamb.rguer/i.test(userText)) {
        return geminiPayload({ isOrderChange: true, action: 'ask_status', plan: { operations: [] }, reply: '' });
      }
      if (/deixa o hamb.rguer e coloca 2 cocas/i.test(userText)) {
        return geminiPayload({
          isOrderChange: true,
          action: 'propose',
          plan: { operations: [{ action: 'add_item', product: 'Coca Cola 2L', quantity: 2 }] },
          reply: '',
        });
      }
      throw new Error(`Unexpected Gemini input: ${userText}`);
    }

    if (target.includes('/api/webhook/whatsapp/order-self-service')) {
      backendBodies.push(body);
      if (body.action === 'lookup') {
        return jsonResponse({ ok: true, orders: [{ id: '11111111-1111-1111-1111-111111111111', orderNumber: '5240', statusLabel: 'novo', totalLabel: 'R$ 40,00' }] });
      }
      if (body.previewOnly && body.changePlan?.operations?.length === 2) {
        return jsonResponse({
          ok: true,
          changeType: 'item_plan',
          operations: [
            { action: 'remove_item', product: 'Hambúrguer', quantity: 1, unitPrice: 20, amount: 20 },
            { action: 'add_item', product: 'Coca Cola 2L', quantity: 1, unitPrice: 16.5, amount: 16.5 },
          ],
          currentTotal: 40,
          proposedTotal: 36.5,
          canonicalChangePlan: { operations: [
            { action: 'remove_item', product: 'Hambúrguer', quantity: 1 },
            { action: 'add_item', product: 'Coca Cola 2L', quantity: 1 },
          ] },
        });
      }
      if (body.previewOnly && body.changePlan?.operations?.length === 1) {
        assert.deepEqual(body.changePlan.operations, [{ action: 'add_item', product: 'Coca Cola 2L', quantity: 2 }]);
        return jsonResponse({
          ok: true,
          changeType: 'item_plan',
          operations: [{ action: 'add_item', product: 'Coca Cola 2L', quantity: 2, unitPrice: 16.5, amount: 33 }],
          currentTotal: 40,
          proposedTotal: 73,
          canonicalChangePlan: { operations: [{ action: 'add_item', product: 'Coca Cola 2L', quantity: 2 }] },
        });
      }
      if (!body.previewOnly && body.changePlan) {
        return jsonResponse({ ok: true, message: '✅ Solicitação enviada à loja para aprovação.' });
      }
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    assert.equal(await handleAiAssistantMessage(baseParams('customer-a', 'Tem como tirar o hambúrguer e adicionar uma coca cola 2l no lugar?', sent)), true);
    assert.match(sent.at(-1), /Remover \*1x Hambúrguer\*/);
    assert.match(sent.at(-1), /Adicionar \*1x Coca Cola 2L\*/);
    assert.match(sent.at(-1), /Novo total: \*R\$ 36,50\*/);

    const callsAfterPreview = backendBodies.length;
    assert.equal(await handleAiAssistantMessage(baseParams('customer-a', 'Conseguiu tirar o hambúrguer?', sent)), true);
    assert.match(sent.at(-1), /Ainda não/);
    assert.equal(backendBodies.length, callsAfterPreview, 'status question must not commit or recalculate the order');

    assert.equal(await handleAiAssistantMessage(baseParams('customer-a', 'Na verdade deixa o hambúrguer e coloca 2 cocas', sent)), true);
    assert.match(sent.at(-1), /Adicionar \*2x Coca Cola 2L\*/);
    assert.match(sent.at(-1), /Novo total: \*R\$ 73,00\*/);

    assert.equal(await handleAiAssistantMessage(baseParams('customer-a', 'Sim', sent)), true);
    const commit = backendBodies.findLast((entry) => entry.action === 'change' && !entry.previewOnly && entry.changePlan);
    assert.ok(commit, 'confirmed plan should be sent to backend');
    assert.deepEqual(commit.changePlan.operations, [{ action: 'add_item', product: 'Coca Cola 2L', quantity: 2 }]);
    assert.match(sent.at(-1), /Solicitação enviada à loja/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('customer can abandon an expensive draft in natural language without sending anything to the store', async () => {
  const sent = [];
  const backendBodies = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const body = options.body ? JSON.parse(options.body) : {};
    if (target.includes('generativelanguage.googleapis.com')) {
      const userText = body?.contents?.[0]?.parts?.[0]?.text || '';
      if (/3 pudim/i.test(userText)) {
        return geminiPayload({ isOrderChange: true, action: 'propose', plan: { operations: [{ action: 'add_item', product: 'Pudim', quantity: 3 }] }, reply: '' });
      }
      if (/achei caro/i.test(userText)) {
        return geminiPayload({ isOrderChange: true, action: 'discard_draft', plan: { operations: [] }, reply: '' });
      }
      throw new Error(`Unexpected Gemini input: ${userText}`);
    }
    if (target.includes('/api/webhook/whatsapp/order-self-service')) {
      backendBodies.push(body);
      if (body.action === 'lookup') return jsonResponse({ ok: true, orders: [{ id: '22222222-2222-2222-2222-222222222222', orderNumber: '6000', statusLabel: 'novo' }] });
      if (body.previewOnly) return jsonResponse({
        ok: true,
        changeType: 'item_plan',
        operations: [{ action: 'add_item', product: 'Pudim', quantity: 3, unitPrice: 29.9, amount: 89.7 }],
        currentTotal: 29.99,
        proposedTotal: 119.69,
        canonicalChangePlan: { operations: [{ action: 'add_item', product: 'Pudim', quantity: 3 }] },
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    await handleAiAssistantMessage(baseParams('customer-b', 'Quero adicionar 3 pudim no pedido', sent));
    assert.match(sent.at(-1), /R\$ 29,90 cada/);
    assert.match(sent.at(-1), /R\$ 119,69/);

    await handleAiAssistantMessage(baseParams('customer-b', 'Achei caro, deixa como estava mesmo', sent));
    assert.match(sent.at(-1), /Descartei essa alteração/);
    const committed = backendBodies.some((entry) => entry.action === 'change' && !entry.previewOnly && entry.changePlan);
    assert.equal(committed, false);
  } finally {
    global.fetch = originalFetch;
  }
});
