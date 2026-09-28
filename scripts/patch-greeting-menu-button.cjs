const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const serverPath = resolve(__dirname, "../src/server.ts");
let source = readFileSync(serverPath, "utf8");
let changed = false;

function replaceOnce(original, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(original)) {
    throw new Error(`Could not locate ${label}; refusing to patch greeting flow.`);
  }
  source = source.replace(original, replacement);
  changed = true;
}

replaceOnce(
  `  fetchLatestWaWebVersion,\n  makeWASocket,`,
  `  fetchLatestWaWebVersion,\n  generateWAMessageFromContent,\n  makeWASocket,\n  proto,`,
  "Baileys imports",
);

const helperMarker = "async function sendMenuGreetingButton(";
if (!source.includes(helperMarker)) {
  const insertionMarker = "async function handleIncomingMessages(id: string, sock: WASocket, messages: any[], type: string) {";
  const insertionIndex = source.indexOf(insertionMarker);
  if (insertionIndex < 0) {
    throw new Error("Could not locate handleIncomingMessages; refusing to patch greeting flow.");
  }

  const helper = `function buildMenuGreetingText(storeInfo: any) {
  const storeName = String(storeInfo?.storeName || "Nome da Loja").trim();
  const menuUrl = String(storeInfo?.menuUrl || "").trim();
  const configured = typeof storeInfo?.autoReplyMessage === "string"
    ? storeInfo.autoReplyMessage.trim()
    : "";

  if (!configured) {
    return \`Olá! 👋 Seja bem-vindo a *\${storeName}*\\n\\nConfira nosso cardápio e faça seu pedido por aqui. 😊\\n\\nÉ só clicar abaixo para ver o cardápio!\`;
  }

  let text = configured
    .replace(/\\{link\\}/gi, "")
    .replace(/_?\\(?\\s*Este é um atendimento automático\\s*\\)?_?/gi, "")
    .trim();

  if (menuUrl) {
    text = text.split(menuUrl).join("");
  }

  text = text
    .replace(/por aqui:\\s*(?=\\n|$)/gi, "por aqui.")
    .replace(/[ \\t]+\\n/g, "\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();

  if (!/clic(?:ar|que)[^\\n]{0,80}card[aá]pio|ver[^\\n]{0,40}card[aá]pio/i.test(text)) {
    text += \`\\n\\nÉ só clicar abaixo para ver o cardápio!\`;
  }

  return text;
}

function buildMenuGreetingBizNode() {
  return {
    tag: "biz",
    attrs: {
      actual_actors: "2",
      host_storage: "2",
      privacy_mode_ts: (Math.floor(Date.now() / 1000) - 77980457).toString(),
    },
    content: [
      {
        tag: "interactive",
        attrs: { type: "native_flow", v: "1" },
        content: [
          {
            tag: "native_flow",
            attrs: { v: "9", name: "mixed" },
          },
        ],
      },
      {
        tag: "quality_control",
        attrs: { source_type: "third_party" },
      },
    ],
  };
}

async function sendMenuGreetingButton(sock: WASocket, customerJid: string, storeInfo: any) {
  const menuUrl = String(storeInfo?.menuUrl || "").trim();
  if (!menuUrl) throw new Error("Store has no menuUrl");

  const replyText = buildMenuGreetingText(storeInfo);

  try {
    const userJid = sock.user?.id;
    if (!userJid) throw new Error("WhatsApp socket has no connected user id");

    const interactiveMessage = proto.Message.InteractiveMessage.create({
      body: proto.Message.InteractiveMessage.Body.create({
        text: replyText,
      }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: [
          proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
            name: "cta_url",
            buttonParamsJson: JSON.stringify({
              display_text: "😍 Ver cardápio",
              url: menuUrl,
              merchant_url: menuUrl,
            }),
          }),
        ],
        messageParamsJson: "{}",
        messageVersion: 1,
      }),
    });

    const message = generateWAMessageFromContent(
      customerJid,
      { interactiveMessage },
      { userJid },
    );

    if (!message.message || !message.key.id) {
      throw new Error("Could not generate interactive greeting message");
    }

    await sock.relayMessage(customerJid, message.message, {
      messageId: message.key.id,
      additionalNodes: [
        { tag: "bot", attrs: { biz_bot: "1" } },
        buildMenuGreetingBizNode(),
      ],
    });

    return "button";
  } catch (error: any) {
    logger.warn(
      { error: error?.message || error, remoteJid: customerJid },
      "[Auto-Reply] Botão do cardápio indisponível; enviando fallback de texto",
    );

    await sock.sendMessage(customerJid, {
      text: \`\${replyText}\\n\\n\${menuUrl}\`,
    });
    return "text-fallback";
  }
}

`;

  source = source.slice(0, insertionIndex) + helper + source.slice(insertionIndex);
  changed = true;
}

const greetingStartMarker = "        let replyText = storeInfo.autoReplyMessage;";
const greetingEndMarker = "      } catch (error: any) {";

if (source.includes(greetingStartMarker)) {
  const start = source.indexOf(greetingStartMarker);
  const end = source.indexOf(greetingEndMarker, start);
  if (end < 0) {
    throw new Error("Could not locate greeting catch block; refusing to patch greeting flow.");
  }

  const replacement = `        const deliveryMode = await sendMenuGreetingButton(sock, customerJid, storeInfo);\n        logger.info(\n          { sessionId: id, remoteJid: customerJid, menuUrl: storeInfo.menuUrl, deliveryMode },\n          "[Auto-Reply] Resposta enviada com sucesso",\n        );\n`;

  source = source.slice(0, start) + replacement + source.slice(end);
  changed = true;
}

if (!source.includes(helperMarker)) {
  throw new Error("Interactive greeting helper was not applied.");
}
if (!source.includes('name: "cta_url"') || !source.includes('display_text: "😍 Ver cardápio"')) {
  throw new Error("CTA URL button was not applied.");
}
if (source.includes("_(Este é um atendimento automático)_`")) {
  throw new Error("Legacy automatic-attendance footer is still present in the greeting template.");
}
if (source.includes("await sock.sendMessage(customerJid, { text: replyText });")) {
  throw new Error("Legacy plain-text greeting send is still present after greeting patch.");
}

if (changed) {
  writeFileSync(serverPath, source, "utf8");
  console.log("[patch-greeting-menu-button] applied");
} else {
  console.log("[patch-greeting-menu-button] already present");
}
