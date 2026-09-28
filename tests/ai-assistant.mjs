import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';

const { buildAiSystemInstruction, extractGeminiText, handleAiAssistantMessage } = await import('../dist/aiAssistant.js');

const logger = { info() {}, warn() {}, error() {} };

test('system instruction keeps store facts bounded and protects critical order actions', () => {
  const prompt = buildAiSystemInstruction({
    storeName: 'Loja Teste',
    menuUrl: 'https://example.test/cardapio',
    autoReplyMessage: 'Bem-vindo',
  });
  assert.match(prompt, /Loja Teste/);
  assert.match(prompt, /https:\/\/example\.test\/cardapio/);
  assert.match(prompt, /Nunca invente preço/);
  assert.match(prompt, /Nunca diga que cancelou, alterou, confirmou ou executou uma ação/);
});

test('extractGeminiText joins text parts and ignores missing candidates', () => {
  assert.equal(extractGeminiText({ candidates: [{ content: { parts: [{ text: 'Olá' }, { text: 'Tudo bem?' }] } }] }), 'Olá\nTudo bem?');
  assert.equal(extractGeminiText({}), '');
});

test('assistant sends Gemini reply without exposing API key in URL', async () => {
  const originalFetch = globalThis.fetch;
  let sent = null;
  let request = null;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Olá! Confira nosso cardápio aqui: https://example.test/cardapio' }] } }] }),
    };
  };
  try {
    const handled = await handleAiAssistantMessage({
      sessionId: 'tenant-1',
      customerJid: '5511999999999@s.whatsapp.net',
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
    assert.equal(body.generationConfig.maxOutputTokens, 220);
    assert.equal(body.contents[0].parts[0].text, 'Oi, quero ver o cardápio');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('assistant returns false on provider error so legacy fallback can run', async () => {
  const originalFetch = globalThis.fetch;
  let sent = false;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED' } }),
  });
  try {
    const handled = await handleAiAssistantMessage({
      sessionId: 'tenant-2',
      customerJid: '5511888888888@s.whatsapp.net',
      text: 'Olá',
      getStoreInfo: async () => ({ storeName: 'Loja Teste', menuUrl: 'https://example.test/cardapio' }),
      sendMessage: async () => { sent = true; },
      logger,
    });
    assert.equal(handled, false);
    assert.equal(sent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
