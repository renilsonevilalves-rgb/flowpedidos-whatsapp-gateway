const fs = require('node:fs');

const path = 'src/server.ts';
const source = fs.readFileSync(path, 'utf8');

const markerStart = 'async function fetchStoreInfo(sessionId: string) {';
const markerEnd = '\n\nfunction unwrapMessage';
const start = source.indexOf(markerStart);
const end = source.indexOf(markerEnd, start);

if (start < 0 || end < 0) {
  throw new Error('Could not locate fetchStoreInfo block; refusing to patch gateway source.');
}

const replacement = `async function fetchStoreInfo(sessionId: string) {
  const baseUrl = (VERCEL_API_URL || 'https://flowoficial01.vercel.app').replace(/\\/$/, '');
  const keys = [API_KEY, API_KEY_2].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
  if (!keys.length) throw new Error('No gateway API key is configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    let lastError: Error | undefined;

    for (const key of keys) {
      try {
        const response = await fetch(\`${baseUrl}/api/webhook/whatsapp/store-info\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
          body: JSON.stringify({ sessionId }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));

        if (response.ok) return data;

        lastError = new Error(\`Vercel store-info returned HTTP \${response.status}: \${data?.error || 'unknown error'}\`);
        logger.warn({ sessionId, status: response.status, keySlot: key === API_KEY ? 'API_KEY' : 'API_KEY_2' }, '[Auto-Reply] store-info request failed');

        if (response.status !== 401 && response.status < 500) break;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError || new Error('Vercel store-info request failed');
  } finally {
    clearTimeout(timer);
  }
}`;

fs.writeFileSync(path, source.slice(0, start) + replacement + source.slice(end), 'utf8');
console.log('[patch-auto-reply-store-info] applied');
