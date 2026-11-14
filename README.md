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
- `WHATSAPP_CHAT_ORDERS_ENABLED=true` no Railway **e** no Vercel. Padrão: desativado.
- `GEMINI_API_KEY`, `GEMINI_MODEL` e `VERCEL_API_URL` configurados apenas no servidor.
- `WHATSAPP_CHAT_ORDER_ALLOWED_TENANTS` no Vercel deve conter UUIDs das lojas-piloto separados por vírgula. Lista vazia bloqueia todos os pedidos conversacionais.
- `API_KEY` do gateway deve corresponder a `WHATSAPP_GATEWAY_API_KEY` no Vercel.
- Requer loja com capacidades `ai_assistant` e `whatsapp_advanced`.
- Cliente pode pedir diretamente no WhatsApp, confirmar carrinho, endereço, pagamento e total.
- Dados, valores, adicionais e taxa de entrega são validados pelo backend e RPC PostgreSQL; Gemini nunca grava pedido diretamente.
- Pagamentos Pix/cartão online reutilizam a página de pagamento da loja. Aprovação ocorre pelo provedor; não aceite "já paguei" por mensagem.
- Entregas por distância/iFood ainda utilizam o checkout do cardápio para cotação. Essa limitação é intencional para não inventar taxas.
- Os rascunhos ficam temporariamente na memória do gateway; reinícios descartam rascunhos, nunca pedidos já gravados. Piloto deve validar recuperação de sessão.
- Não ativar em todas as lojas sem homologar as rotas, duplicidades, preços, personalizações, loja fechada e pagamento real em sandbox.

## Atendente de pedidos pela conversa (src/atendente)
Conversa livre (sem botões e sem menu de números) que monta o pedido, mostra o resumo com valores
oficiais do backend e só grava depois do "sim" do cliente ao resumo mais recente.
- Liga por loja: `WHATSAPP_AI_ORDER_TENANTS` (Railway) = IDs das lojas separados por vírgula. Vazio = desligado.
- Na Vercel a loja precisa estar em `WHATSAPP_CHAT_ORDER_ALLOWED_TENANTS` com `WHATSAPP_CHAT_ORDERS_ENABLED=true`.
- Usa `GEMINI_API_KEY` e `GEMINI_MODEL` (opcional `GEMINI_FALLBACK_MODEL`). Sem Gemini, responde com o link do cardápio sem perder o carrinho.
- Pedidos já feitos (acompanhar, alterar, cancelar) continuam no atendimento atual.
- Opcionais: `ATENDENTE_DEBOUNCE_MS` (junta mensagens seguidas, padrão 1500), `ATENDENTE_STATE_TTL_MINUTES` (padrão 180).
- Testes: `tests/atendente.mjs`.

## Saúde da conexão (src/connectionHealth.ts)
Evita a conexão "zumbi" (loja aparece conectada, mas o WhatsApp para de entregar mensagens).
- Ao reconectar, o WhatsApp entrega as pendências em lotes; o gateway pede o próximo lote sempre que o anterior termina,
  até a sincronização concluir. Sem isso, lojas com mais de 100 pendências ficavam sem receber nada.
- Se a sincronização não terminar em 3 min, ou se uma mensagem recebida não for processada em 2 min, a loja é
  reconectada sozinha (com espera crescente se travar de novo). Lojas sem movimento nunca são reconectadas à toa.
- Mensagens que o cliente mandou durante quedas/reinícios (até 15 min) agora são respondidas; se a loja já respondeu
  pelo celular nesse meio-tempo, o robô fica pausado para aquele cliente.
- Opcionais: `WHATSAPP_HEALTH_WATCHDOG=false` desliga a vigilância; `WHATSAPP_REPLY_OFFLINE_MESSAGES=false` não responde
  mensagens da queda; `WHATSAPP_OFFLINE_REPLY_MAX_AGE_MINUTES` (padrão 15); `WHATSAPP_HEALTH_OFFLINE_DEADLINE_MS`
  (padrão 180000); `WHATSAPP_HEALTH_INBOUND_STALL_MS` (padrão 120000).
- Logs: `[Health]` e `[Offline]`. Testes: `tests/connection-health.mjs`.
