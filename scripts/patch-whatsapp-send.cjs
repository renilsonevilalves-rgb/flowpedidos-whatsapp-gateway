const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'src', 'server.ts');
let source = fs.readFileSync(file, 'utf8');

const oldBlock = `    await session.sock.sendMessage(\`${'${phone}'}@s.whatsapp.net\`, { text });\n    logger.info({ sessionId, phone }, "[Outbound] Mensagem enviada com sucesso");\n    res.json({ ok: true, phone });`;

const newBlock = `    const recipients = await session.sock.onWhatsApp(phone);\n    const recipient = recipients.find((item: any) => item?.exists && item?.jid);\n\n    if (!recipient?.jid) {\n      logger.warn({ sessionId, phone }, "[Outbound] Número não encontrado no WhatsApp");\n      res.status(404).json({ ok: false, error: "O número informado não possui uma conta WhatsApp válida." });\n      return;\n    }\n\n    const sentMessage = await session.sock.sendMessage(recipient.jid, { text });\n    logger.info({ sessionId, phone, recipientJid: recipient.jid, messageId: sentMessage?.key?.id || null }, "[Outbound] Mensagem aceita pelo WhatsApp");\n    res.json({ ok: true, phone, recipientJid: recipient.jid, messageId: sentMessage?.key?.id || null });`;

if (!source.includes('const recipients = await session.sock.onWhatsApp(phone);')) {
  if (!source.includes(oldBlock)) {
    console.error('[patch-whatsapp-send] Bloco esperado não encontrado em src/server.ts. Build interrompido.');
    process.exit(1);
  }
  source = source.replace(oldBlock, newBlock);
}

const trackingHelper = `async function fetchOrderStatus(sessionId: string, phone: string) {\n  if (!VERCEL_API_URL) throw new Error("VERCEL_API_URL is not configured on the gateway");\n  const controller = new AbortController();\n  const timer = setTimeout(() => controller.abort(), 8000);\n  try {\n    const response = await fetch(\`${'${VERCEL_API_URL}'}/api/webhook/whatsapp/order-status\`, {\n      method: "POST",\n      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },\n      body: JSON.stringify({ sessionId, phone }),\n      signal: controller.signal,\n    });\n    const data = await response.json().catch(() => ({}));\n    if (!response.ok) throw new Error(data?.error || \`Order-status returned HTTP ${'${response.status}'}\`);\n    return data;\n  } finally { clearTimeout(timer); }\n}\n\nfunction isTrackOrderTrigger(text: string) {\n  const normalized = text.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").trim();\n  return /^(acompanhar\\s+pedido|acompanhar\\s+meu\\s+pedido|status\\s+do\\s+pedido|rastrear\\s+pedido)[!,.?\\s]*$/i.test(normalized);\n}\n\n`;

if (!source.includes('function isTrackOrderTrigger')) {
  const marker = 'function isAutoReplyTrigger(text: string) {';
  if (!source.includes(marker)) {
    console.error('[patch-whatsapp-send] Tracking insertion marker not found. Build interrupted.');
    process.exit(1);
  }
  source = source.replace(marker, trackingHelper + marker);
}

// TypeScript strict mode treats catch variables as unknown. The tracking handler
// needs an explicit type because it logs error.message.
source = source.replace(
  '        } catch (error) {\n          logger.error({ error: error?.message || error, sessionId: id, remoteJid }, "[Order-Tracking] Falha ao consultar/enviar status");',
  '        } catch (error: any) {\n          logger.error({ error: error?.message || error, sessionId: id, remoteJid }, "[Order-Tracking] Falha ao consultar/enviar status");'
);

if (!source.includes('const isTrackingTrigger = isTrackOrderTrigger(text);')) {
  const marker = `      const isTrigger = isAutoReplyTrigger(text);\n      if (!isTrigger) continue;`;
  const replacement = `      const isTrackingTrigger = isTrackOrderTrigger(text);\n      if (isTrackingTrigger) {\n        try {\n          const customerPhone = remoteJid.split("@")[0].split(":")[0];\n          const result = await fetchOrderStatus(id, customerPhone);\n          await sock.sendMessage(remoteJid, { text: result.message });\n          logger.info({ sessionId: id, remoteJid, orderId: result.orderId }, "[Order-Tracking] Status enviado com sucesso");\n        } catch (error: any) {\n          logger.error({ error: error?.message || error, sessionId: id, remoteJid }, "[Order-Tracking] Falha ao consultar/enviar status");\n          await sock.sendMessage(remoteJid, { text: "Não consegui localizar seu pedido agora. Verifique se o pedido foi feito com este mesmo número de WhatsApp e tente novamente. 🙏" }).catch(() => undefined);\n        }\n        continue;\n      }\n\n      const isTrigger = isAutoReplyTrigger(text);\n      if (!isTrigger) continue;`;
  if (!source.includes(marker)) {
    console.error('[patch-whatsapp-send] Message handler marker not found. Build interrupted.');
    process.exit(1);
  }
  source = source.replace(marker, replacement);
}

fs.writeFileSync(file, source, 'utf8');
console.log('[patch-whatsapp-send] Outbound recipient validation and order tracking applied.');
