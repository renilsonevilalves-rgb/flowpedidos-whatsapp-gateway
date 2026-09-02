const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'src', 'server.ts');
let source = fs.readFileSync(file, 'utf8');

const helper = `
async function resolveCustomerPhone(sock: WASocket, msg: any, remoteJid: string) {
  const candidates = [
    msg?.key?.remoteJidAlt,
    msg?.key?.senderPn,
    msg?.key?.participantPn,
    msg?.key?.participantAlt,
    remoteJid,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = String(candidate);
    if (value.endsWith('@s.whatsapp.net')) {
      const digits = value.split('@')[0].split(':')[0].replace(/\D/g, '');
      if (digits) return digits;
    }
  }

  if (remoteJid.endsWith('@lid')) {
    try {
      const mapped = await (sock as any).signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
      if (mapped) {
        const digits = String(mapped).split('@')[0].split(':')[0].replace(/\D/g, '');
        if (digits) return digits;
      }
    } catch (error) {
      logger.warn({ error, remoteJid }, '[Order-Tracking] Falha ao resolver LID para telefone');
    }
  }

  return null;
}
`;

// This patch is optional for the automatic order-confirmation path.
// Never fail the production build just because the tracking block has a
// different source shape. Apply the tracking enhancement only when the
// expected source pattern is present; otherwise preserve the existing logic.
if (!source.includes('async function resolveCustomerPhone(')) {
  const marker = 'async function handleIncomingMessages(id: string, sock: WASocket, messages: any[], type: string) {';
  if (source.includes(marker)) source = source.replace(marker, helper + '\n' + marker);
}

const newFetchOrderStatus = `async function fetchOrderStatus(sessionId: string, phone: string, orderNumber = '') {
  if (!VERCEL_API_URL) throw new Error("VERCEL_API_URL is not configured on the gateway");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(\`${'${VERCEL_API_URL}'}/api/webhook/whatsapp/order-status\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({ sessionId, phone, orderNumber }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || \`Order-status returned HTTP ${'${response.status}'}\`);
    return data;
  } finally { clearTimeout(timer); }
}`;

const fetchPattern = /async function fetchOrderStatus\(sessionId: string, phone: string\) \{[\s\S]*?\n\}\n\nfunction isAutoReplyTrigger/;
if (fetchPattern.test(source)) {
  source = source.replace(fetchPattern, newFetchOrderStatus + '\n\nfunction isAutoReplyTrigger');
}

const replacement = `const trackingOrderNumber = text.match(/^acompanhar\\s+pedido\\s+(FP-[A-Z0-9-]+)$/i)?.[1]?.toUpperCase() || '';
          const customerPhone = trackingOrderNumber ? null : await resolveCustomerPhone(sock, msg, remoteJid);
          if (!customerPhone && !trackingOrderNumber) throw new Error("Não foi possível identificar o número de telefone deste contato do WhatsApp.");
          const result = await fetchOrderStatus(id, customerPhone || '', trackingOrderNumber);`;

const oldSimple = 'const customerPhone = remoteJid.split("@")[0].split(":")[0];\n          const result = await fetchOrderStatus(id, customerPhone);';
const oldCurrent = /const customerJid = \[[\s\S]*?const customerPhone = customerJid\.split\("@"\)\.split\(":"\)\[0\];\n\s*const result = await fetchOrderStatus\(id, customerPhone\);/;
const oldHelper = /const customerPhone = await resolveCustomerPhone\(sock, msg, remoteJid\);\n\s*if \(!customerPhone\) throw new Error\("Não foi possível identificar o número de telefone deste contato do WhatsApp\."\);\n\s*const result = await fetchOrderStatus\(id, customerPhone\);/;

if (source.includes(oldSimple)) source = source.replace(oldSimple, replacement);
else if (oldCurrent.test(source)) source = source.replace(oldCurrent, replacement);
else if (oldHelper.test(source)) source = source.replace(oldHelper, replacement);

fs.writeFileSync(file, source);
console.log('patch-lid-tracking: OK');
