const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'src', 'server.ts');
const source = fs.readFileSync(file, 'utf8');

const oldBlock = `    await session.sock.sendMessage(\`${'${phone}'}@s.whatsapp.net\`, { text });\n    logger.info({ sessionId, phone }, "[Outbound] Mensagem enviada com sucesso");\n    res.json({ ok: true, phone });`;

const newBlock = `    const recipients = await session.sock.onWhatsApp(phone);\n    const recipient = recipients.find((item: any) => item?.exists && item?.jid);\n\n    if (!recipient?.jid) {\n      logger.warn({ sessionId, phone }, "[Outbound] Número não encontrado no WhatsApp");\n      res.status(404).json({ ok: false, error: "O número informado não possui uma conta WhatsApp válida." });\n      return;\n    }\n\n    const sentMessage = await session.sock.sendMessage(recipient.jid, { text });\n    logger.info({\n      sessionId,\n      phone,\n      recipientJid: recipient.jid,\n      messageId: sentMessage?.key?.id || null,\n    }, "[Outbound] Mensagem aceita pelo WhatsApp");\n    res.json({\n      ok: true,\n      phone,\n      recipientJid: recipient.jid,\n      messageId: sentMessage?.key?.id || null,\n    });`;

if (source.includes('const recipients = await session.sock.onWhatsApp(phone);')) {
  process.exit(0);
}

if (!source.includes(oldBlock)) {
  console.error('[patch-whatsapp-send] Bloco esperado não encontrado em src/server.ts. Build interrompido para evitar uma implantação incompleta.');
  process.exit(1);
}

fs.writeFileSync(file, source.replace(oldBlock, newBlock), 'utf8');
console.log('[patch-whatsapp-send] Verificação real do destinatário WhatsApp aplicada.');
