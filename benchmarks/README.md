# Experimento de carga local

Relatórios reais preservados: [carteiras distribuídas](distributed-600-12.json) e [hot wallet](hot-600-12.json). Gerados em 07/11/2026 com `bun run test:load`; nenhum resultado foi preenchido manualmente.

## Ambiente e método

- Gerador: Bun 1.3.11 no Windows, AMD Ryzen 9 5900X, 24 CPUs lógicas, aproximadamente 32 GiB de RAM do host.
- Docker Desktop / Engine 29.2.0 com 24 CPUs lógicas e 16.727.044.096 bytes disponíveis à VM; sem quotas específicas por serviço no Compose.
- Três processos da aplicação em containers Linux, PostgreSQL 17.6 e LocalStack 4.10.0. OpenTelemetry, Jaeger, Prometheus e Grafana estavam habilitados.
- Cada cenário envia 600 requisições HTTP em modelo fechado, com até 12 requisições simultâneas. Não é um teste de taxa de chegada aberta.
- Cada operação nova é uma BET de `0.01 BRL`. Uma carteira começa com `1000000.00 BRL`, evitando rejeições por saldo insuficiente no experimento.
- A cada dez posições, uma operação anterior é repetida com a mesma identidade: 541 operações únicas e 59 replays por cenário.
- O cenário distribuído usa 12 carteiras; o hot usa uma carteira. Ambos direcionam requisições às três instâncias.
- Criação de carteiras e leitura inicial de métricas aquecem o ambiente, mas não há fase separada de aquecimento estatístico. Setup e reconciliação ficam fora da duração medida.
- Latência usa relógio monotônico, do envio até a leitura completa da resposta. Inclui espera da aplicação, banco e rede local, mas não a espera de um job ainda não iniciado pelo gerador.
- Depois da carga, são conferidos efeitos únicos e snapshots estáveis de replay, saldo esperado, igualdade wallet/ledger, dois postings por movimento e igualdade entre débitos/créditos. Qualquer erro financeiro ou HTTP dá exit code diferente de zero.

## Resultados observados

| Cenário | Duração | Req/s | p50 | p95 | p99 | Erros HTTP/rede | Divergências |
|---|---:|---:|---:|---:|---:|---:|---:|
| 12 carteiras | 3,01 s | 199,20 | 54,62 ms | 105,26 ms | 130,17 ms | 0 / 600 | 0 |
| Uma hot wallet | 9,62 s | 62,37 | 67,97 ms | 589,98 ms | 756,75 ms | 0 / 600 | 0 |

Os dois cenários tiveram 59 replays, exatamente 541 efeitos únicos e zero timeouts/deadlocks contabilizados como conflitos de lock. Isso **não** significa ausência de espera por lock: requisições podem aguardar a mesma wallet sem atingir o timeout.

No cenário distribuído foram reconciliados 553 movimentos, incluindo 12 aberturas, e 1.106 postings. No hot foram 542 movimentos, incluindo a abertura, e 1.084 postings. Todas as carteiras reconciliaram.

| Métrica | Distribuído | Hot wallet |
|---|---:|---:|
| Maior lag nas amostras anteriores à carga | 0,093 s | 0,000 s |
| Maior lag nas amostras posteriores à carga | 1,776 s | 0,141 s |
| Conflitos de lock novos | 0 | 0 |

Lag é amostrado por réplica antes/depois da carga e não é um pico medido continuamente nem uma latência de entrega ao consumidor. Os cenários rodaram sequencialmente; nesta execução, as amostras anteriores ao hot indicavam lag zero. O tempo de publicação assíncrona não está incluído na latência HTTP.

## Interpretação e limites

Nestes ensaios curtos, concentrar as operações em uma carteira elevou a cauda de latência e reduziu o throughput. O lock por wallet e o custo crescente das verificações do histórico são hipóteses compatíveis com isso; o experimento não isola essas causas individualmente.

Os números são uma evidência local de comportamento e correção, sem meta de RPS. Não representam capacidade de produção, teste de longa duração, ponto de saturação ou estimativa estatística com múltiplas repetições. Cache, volume de histórico, outros processos do host, instrumentação e recursos do Docker influenciam o resultado. Os relatórios contêm os dados brutos e o ambiente observado para reprodução.

## Reproduzir

```sh
docker compose -f compose.yaml -f compose.observability.yaml up -d --build --scale app=3 --wait
docker compose port --index 1 app 3000
docker compose port --index 2 app 3000
docker compose port --index 3 app 3000
```

Substitua as URLs pelas portas efetivas. As URLs dos relatórios são as usadas naquela execução, não portas fixas do projeto.

```sh
bun run test:load --urls=http://localhost:3002,http://localhost:3003,http://localhost:3004 --scenario=distributed --requests=600 --concurrency=12 --wallets=12
bun run test:load --urls=http://localhost:3002,http://localhost:3003,http://localhost:3004 --scenario=hot --requests=600 --concurrency=12
```

O runner salva o último relatório por combinação de cenário/requisições/concorrência. Copie-o antes de repetir se quiser comparar repetições. Para um ensaio mais longo, aumente `--requests`; para estudar contenção, varie separadamente concorrência e quantidade de carteiras. A CI executa apenas uma carga menor de smoke e publica seu próprio relatório, sem implicar que os números locais serão reproduzidos no runner remoto.
