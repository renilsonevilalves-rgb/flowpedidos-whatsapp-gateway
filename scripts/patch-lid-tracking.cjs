const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'src', 'server.ts');
let source = fs.readFileSync(file, 'utf8');

const helper = `\nasync function resolveCustomerPhone(sock: WASocket, msg: any, remoteJid: string) {\n  const candidates = [\n    msg?.key?.remoteJidAlt,\n    msg?.key?.participantAlt,\n    remoteJid,\n  ].filter(Boolean);\n\n  for (const candidate of candidates) {\n    const value = String(candidate);\n    if (value.endsWith('@s.whatsapp.net')) {\n      const digits = value.split('@')[0].split(':')[0].replace(/\\D/g, '');\n      if (digits) return digits;\n    }\n  }\n\n  if (remoteJid.endsWith('@lid')) {\n    try {\n      const mapped = await (sock as any).signalRepository?.lidMapping?.getPNForLID?.(remoteJid);\n      if (mapped) {\n        const digits = String(mapped).split('@')[0].split(':')[0].replace(/\\D/g, '');\n        if (digits) return digits;\n      }\n    } catch (error) {\n      logger.warn({ error, remoteJid }, '[Order-Tracking] Falha ao resolver LID para telefone');\n    }\n  }\n\n  return null;\n}\n`;

if (!source.includes('async function resolveCustomerPhone(')) {
  const marker = 'async function handleIncomingMessages(id: string, sock: WASocket, messages: any[], type: string) {';
  if (!source.includes(marker)) {
    throw new Error('patch-lid-tracking: handleIncomingMessages marker not found');
  }
  source = source.replace(marker, helper + '\n' + marker);
}

const old = 'const customerPhone = remoteJid.split("@")[0].split(":")[0];\n          const result = await fetchOrderStatus(id, customerPhone);';
const replacement = 'const customerPhone = await resolveCustomerPhone(sock, msg, remoteJid);\n          if (!customerPhone) throw new Error("Não foi possível identificar o número de telefone deste contato do WhatsApp.");\n          const result = await fetchOrderStatus(id, customerPhone);';

if (source.includes(old)) {
  source = source.replace(old, replacement);
} else if (!source.includes(replacement)) {
  throw new Error('patch-lid-tracking: tracking phone extraction block not found');
}

fs.writeFileSync(file, source);
console.log('patch-lid-tracking: OK');
