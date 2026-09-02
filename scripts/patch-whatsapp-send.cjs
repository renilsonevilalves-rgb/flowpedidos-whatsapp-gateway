const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'src', 'server.ts');
const source = fs.readFileSync(file, 'utf8');

const oldBlock = `    await session.sock.sendMessage(\`${'${phone}'}@s.whatsapp.net\`, { text });\n    logger.info({ sessionId, phone }, "[Outbound] Mensagem enviada com sucesso");\n    res.json({ ok: true, phone });`;

const newBlock = `    const recipients = (await session.sock.onWhatsApp(phone)) || [];\n    const recipient = recipients.find((item: any) => item?.exists && item?.jid);\n\n    if (!recipient?.jid) {\n      logger.warn({ sessionId, phone }, "[Outbound] Número não encontrado no WhatsApp");\n      res.status(404).json({ ok: false, error: "O número informado não possui uma conta WhatsApp válida." });\n      return;\n    }\n\n    const pnJid = recipient.jid;\n    let targetJid = pnJid;\n\n    // WhatsApp now uses LID for many personal chats. Resolve the PN to its\n    // LID from Baileys' mapping store when available, then send to the actual\n    // conversation identity. This prevents a false HTTP 200 where the gateway\n    // accepts a PN but WhatsApp does not route the message to the LID chat.\n    try {\n      const lidMapping = (session.sock as any)?.signalRepository?.lidMapping;\n      const lid = typeof lidMapping?.getLIDForPN === "function"\n        ? await lidMapping.getLIDForPN(pnJid)\n        : undefined;\n      if (typeof lid === "string" && /@lid$/.test(lid)) {\n        targetJid = lid;\n      }\n    } catch (error) {\n      logger.warn({ error, sessionId, phone, pnJid }, "[Outbound] Falha ao resolver LID; usando PN");\n    }\n\n    const sentMessage = await session.sock.sendMessage(targetJid, { text });\n    const messageId = sentMessage?.key?.id || null;\n    logger.info({\n      sessionId,\n      phone,\n      pnJid,\n      targetJid,\n      messageId,\n    }, "[Outbound] Mensagem aceita pelo WhatsApp");\n    res.json({\n      ok: true,\n      phone,\n      recipientJid: targetJid,\n      messageId,\n    });`;

if (source.includes('const pnJid = recipient.jid;')) {
  process.exit(0);
}

if (!source.includes(oldBlock)) {
  console.error('[patch-whatsapp-send] Bloco esperado não encontrado em src/server.ts. Build interrompido para evitar uma implantação incompleta.');
  process.exit(1);
}

fs.writeFileSync(file, source.replace(oldBlock, newBlock), 'utf8');
console.log('[patch-whatsapp-send] Verificação de destinatário + resolução PN/LID aplicada.');
