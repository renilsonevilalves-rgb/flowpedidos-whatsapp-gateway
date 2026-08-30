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
