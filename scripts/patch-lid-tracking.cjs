const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'src', 'server.ts');
let source = fs.readFileSync(file, 'utf8');

const helper = `\nasync function resolveCustomerPhone(sock: WASocket, msg: any, remoteJid: string) {\n  const candidates = [\n    msg?.key?.remoteJidAlt,\n    msg?.key?.senderPn,\n    msg?.key?.participantPn,\n    msg?.key?.participantAlt,\n    remoteJid,\n  ].filter(Boolean);\n\n  for (const candidate of candidates) {\n    const value = String(candidate);\n    if (value.endsWith('@s.whatsapp.net')) {\n      const digits = value.split('@')[0].split(':')[0].replace(/\\D/g, '');\n      if (digits) return digits;\n    }\n  }\n\n  if (remoteJid.endsWith('@lid')) {\n    try {\n      const mapped = await (sock as any).signalRepository?.lidMapping?.getPNForLID?.(remoteJid);\n      if (mapped) {\n        const digits = String(mapped).split('@')[0].split(':')[0].replace(/\\D/g, '');\n        if (digits) return digits;\n      }\n    } catch (error) {\n      logger.warn({ error, remoteJid }, '[Order-Tracking] Falha ao resolver LID para telefone');\n    }\n  }\n\n  return null;\n}\n`;

if (!source.includes('async function resolveCustomerPhone(')) {
  const marker = 'async function handleIncomingMessages(id: string, sock: WASocket, messages: any[], type: string) {';
  if (!source.includes(marker)) throw new Error('patch-lid-tracking: handleIncomingMessages marker not found');
  source = source.replace(marker, helper + '\n' + marker);
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
} else if (!source.includes('async function fetchOrderStatus(sessionId: string, phone: string, orderNumber = \'\')')) {
  throw new Error('patch-lid-tracking: fetchOrderStatus function not found');
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
else if (!source.includes('const trackingOrderNumber = text.match(/^acompanhar\\s+pedido')) throw new Error('patch-lid-tracking: tracking block not found');

fs.writeFileSync(file, source);
console.log('patch-lid-tracking: OK');
