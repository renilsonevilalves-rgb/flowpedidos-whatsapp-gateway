# FlowPedidos WhatsApp Gateway

Gateway separado do FlowPedidos para conexão de WhatsApp via QR Code usando Baileys.

## Requisitos
- Node.js 20+
- `PORT` fornecida pelo Railway
- `API_KEY` definida no Railway
- Volume persistente montado em `/data` para manter as sessões

## Variáveis
- `PORT` — fornecida automaticamente pelo Railway
- `API_KEY` — segredo usado pelo FlowPedidos para chamar o gateway
- `FRONTEND_URL` — domínio do FlowPedidos, opcional; usado para CORS

## Endpoints
- `GET /health`
- `POST /session/:sessionId/start`
- `GET /session/:sessionId/status`
- `GET /session/:sessionId/qr`
- `POST /session/:sessionId/logout`

Não exponha a `API_KEY` no navegador. O frontend deverá chamar um backend seguro que mantém essa chave no servidor.


## Pedidos por conversa Gemini (opt-in)
- \`WHATSAPP_CHAT_ORDERS_ENABLED=true\` no Railway **e** no Vercel. Padrão: desativado.
- \`GEMINI_API_KEY\`, \`GEMINI_MODEL\` e \`VERCEL_API_URL\` configurados apenas no servidor.
- \`API_KEY\` do gateway deve corresponder a \`WHATSAPP_GATEWAY_API_KEY\` no Vercel.
- Requer loja com capacidades \`ai_assistant\` e \`whatsapp_advanced\`.
- Cliente pode pedir diretamente no WhatsApp, confirmar carrinho, endereço, pagamento e total.
- Dados, valores, adicionais e taxa de entrega são validados pelo backend e RPC PostgreSQL; Gemini nunca grava pedido diretamente.
- Pagamentos Pix/cartão online reutilizam a página de pagamento da loja. Aprovação ocorre pelo provedor; não aceite "já paguei" por mensagem.
- Entregas por distância/iFood ainda utilizam o checkout do cardápio para cotação. Essa limitação é intencional para não inventar taxas.
- Os rascunhos ficam temporariamente na memória do gateway; reinícios descartam rascunhos, nunca pedidos já gravados. Piloto deve validar recuperação de sessão.
- Não ativar em todas as lojas sem homologar as rotas, duplicidades, preços, personalizações, loja fechada e pagamento real em sandbox.
