# Jungle Wagering Processor

Serviço financeiro distribuído para o [desafio backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge): precisão monetária, concorrência por carteira, idempotência persistente e recuperação de falhas.

**Stack:** Bun 1.3.11 · TypeScript estrito · NestJS 11 · MikroORM 6.6 · PostgreSQL 17 · AWS SQS via LocalStack · Docker Compose.

## Executar com Docker

Pré-requisitos: Docker Engine/Desktop com containers Linux e Docker Compose v2. Não é necessário instalar Bun no host para executar a aplicação.

```sh
docker compose up -d --build --wait
docker compose ps
```

O serviço `init` executa as migrations e cria as filas antes da aplicação. A primeira instância usa uma porta disponível no intervalo **3000–3009**, começando por 3000. Consulte a porta efetiva:

```sh
docker compose port --index 1 app 3000
```

```sh
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics
```

Para três instâncias, com workers e publishers independentes em cada processo:

```sh
docker compose up -d --build --scale app=3 --wait
docker compose ps
```

As portas usuais são 3000, 3001 e 3002. PostgreSQL (5432), LocalStack (4566) e HTTP são expostos apenas em loopback. As credenciais do Compose são exclusivamente locais. O PostgreSQL tem volume persistente; LocalStack é efêmero nesta configuração. Recrie as filas com `bun run queues:init` se reiniciar somente LocalStack e execute `docker compose restart app` em seguida.

```sh
docker compose logs -f app
docker compose down
```

`down` preserva o volume do PostgreSQL. Não use `down -v` se quiser preservar o histórico financeiro.

## Desenvolvimento e testes

Instale Bun 1.3.11. As configurações locais padrão estão em `.env.example`; Bun lê `.env` automaticamente, se criado. As credenciais e endpoints padrão já permitem rodar com o Compose.

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres localstack
bun run db:migrate
bun run queues:init
bun run dev
```

```sh
bun run typecheck
bun run lint
bun test
bun run test:integration
bun run test:all
```

`test:integration` cria um banco temporário e filas exclusivas, verifica migrations `up → down → up`, executa testes reais e remove apenas seus recursos temporários. O usuário PostgreSQL precisa de `CREATEDB` para esse runner; o usuário local do Compose tem essa permissão. Os testes não apagam o banco de desenvolvimento. Use o runner, em vez de executar os arquivos de integração diretamente contra outro ambiente.

Os testes incluem 50 duplicatas concorrentes, disputa de saldo, três processos Bun/NestJS, carteiras independentes, reinício, morte do worker após commit e antes do ack, inbox, DLQ, referências fora de ordem, publishers concorrentes, falhas de publicação e proteções SQL. Os pontos de falha injetados ficam nos testes e nas dependências substituíveis, sem endpoints de sabotagem na API.

A workflow em `.github/workflows/ci.yaml` executa as mesmas verificações com PostgreSQL e LocalStack reais. Sua execução no GitHub depende da publicação do repositório.

Para reverter **a última migration** em um ambiente descartável:

```sh
bun run db:rollback
bun run db:migrate
```

## Demonstração reproduzível

Com a aplicação e os workers em execução:

```sh
bun run demo
```

O script cria uma carteira com `100.00`, aposta `25.00`, repete a mesma aposta e envia um `WIN` de `10.00` pelo SQS. O resultado esperado é saldo **`85.00`**, três lançamentos no ledger (incluindo abertura) e reconciliação consistente. Cada execução usa IDs novos. Para outra porta, configure `API_URL` no ambiente.

## API HTTP

| Método | Rota | Finalidade |
|---|---|---|
| POST | `/wallets` | Abrir carteira e auditar saldo inicial positivo |
| GET | `/wallets/:walletId` | Consultar saldo e versão |
| GET | `/wallets/:walletId/ledger?cursor=...&limit=50` | Ledger em ordem de versão, cursor opaco |
| POST | `/wagering/transactions` | Submeter operação, com `Idempotency-Key` obrigatório |
| GET | `/wagering/transactions/:transactionId` | Consultar operação pelo ID interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar pelo ID do provedor |
| POST | `/wallets/:walletId/reconciliation` | Comparar saldo armazenado com soma do ledger |
| GET | `/health/live` | Processo vivo |
| GET | `/health/ready` | PostgreSQL e as três filas alcançáveis |
| GET | `/metrics` | Métricas Prometheus por instância |

Exemplo de criação:

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Exemplo de aposta — substitua `walletId` pelo ID retornado:

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-123
X-Correlation-Id: example-123
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Para REFUND/ROLLBACK, informe `referenceExternalTransactionId`, com o ID **externo** da operação original e o mesmo valor integral. `WIN` aceita referência opcional a uma BET. `LOSS` não movimenta saldo. `OPENING` é exclusivamente interno.

| HTTP na submissão | Significado |
|---|---|
| 200 | Operação processada ou replay processado |
| 202 | Aceita, aguardando referência |
| 400 | Contrato inválido, dinheiro inválido ou header ausente |
| 409 | Chave/payload ou identidade externa conflitantes; carteira duplicada na criação |
| 422 | Rejeição de negócio persistida, com `failureCode` |
| 500 | Falha permanente / erro interno; uma operação persistida `FAILED` é auditável |
| 503 | Falha transitória de infraestrutura; `Retry-After: 1` |

Criação de carteira retorna 201; consultas e reconciliação retornam 200. Consultas de recurso inexistente retornam 404; UUID malformado retorna 400. Replays terminais preservam o saldo original. Consultas de transações retornam 200 mesmo quando o recurso está `REJECTED` ou `FAILED` — o status financeiro fica no corpo.

## Filas e eventos

- Entrada: `wager-transactions.fifo`.
- Mensagens permanentes ou com tentativas esgotadas: `wager-transactions-dlq.fifo`.
- Eventos da outbox: `wager-events.fifo`.

O envelope de entrada tem `messageId`, `type: "WagerTransactionRequested"`, `occurredAt` ISO e `data` com o contrato da transação mais `idempotencyKey`. Use `MessageGroupId = walletId` e um `MessageDeduplicationId` explícito. A deduplicação definitiva continua no PostgreSQL, mesmo depois da janela de deduplicação FIFO.

Eventos: `WagerTransactionProcessed` (inclui LOSS), `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged` (somente mudança de saldo) e `WagerTransactionFailed`. A publicação é **at-least-once**: consumidores de eventos devem deduplicar persistentemente por `eventId`. `walletVersion` permite detectar eventos de saldo entregues fora de ordem.

## Diagnóstico e limites

Logs da aplicação são JSON com contexto e sem payload financeiro completo. Métricas incluem resultados por status, duplicatas, retries, DLQ, conflitos de lock, atraso da outbox, latência e divergência de reconciliação. Contadores são locais ao processo: configure coleta por instância. Divergências são sinalizadas e nunca corrigidas silenciosamente.

Autenticação foi deixada como ponto de extensão explícito e não está ativa. As decisões sobre locks, idempotência, referências, shutdown, retenção e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).
