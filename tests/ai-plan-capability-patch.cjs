const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const aiPath = resolve(__dirname, '../src/aiAssistantV2.ts');

function readAiSource() {
  return readFileSync(aiPath, 'utf8');
}

test('AI assistant checks the plan capability before Gemini or legacy AI', () => {
  const source = readAiSource();
  const storeInfoIndex = source.indexOf('const storeInfo = await params.getStoreInfo();');
  const denyIndex = source.indexOf('storeInfo?.capabilities?.ai_assistant === false');
  const geminiIndex = source.indexOf('requestInterpretation(params, storeInfo || {}, null)');
  const legacyAfterGateIndex = source.indexOf('if (!GEMINI_API_KEY) return await handleLegacyAiAssistantMessage(params);');

  assert.ok(storeInfoIndex >= 0, 'store info entitlement lookup is missing');
  assert.ok(denyIndex > storeInfoIndex, 'AI plan denial must run after store info is loaded');
  assert.ok(legacyAfterGateIndex > denyIndex, 'legacy AI fallback must remain behind the plan gate');
  assert.ok(geminiIndex > denyIndex, 'Gemini interpretation must remain behind the plan gate');
  assert.equal(
    source.includes('if (!GEMINI_API_KEY) return handleLegacyAiAssistantMessage(params);'),
    false,
    'an early legacy AI fallback would bypass plan enforcement',
  );
});

test('AI assistant fails closed when entitlement lookup fails', () => {
  const source = readAiSource();
  assert.match(source, /let storeInfoLoaded = false;/);
  assert.match(source, /if \(!storeInfoLoaded\) return false;/);
});

test('store info type carries only the AI entitlement needed by the gateway', () => {
  const source = readAiSource();
  assert.match(source, /capabilities\?: \{ ai_assistant\?: boolean \} \| null;/);
});
