# Arquitetura e correção

## Separação de responsabilidades

`src/domain` contém classes independentes de frameworks, com construtores privados, fábricas explícitas e transições de estado controladas. `src/application` coordena os casos de uso por meio das portas `FinancialStore` e `FinancialSession`. PostgreSQL, SQS, observabilidade e HTTP são adaptadores. Tanto a entrada HTTP quanto a entrada SQS chamam `WageringService.submit`.

As regras de entrada e de contexto das referências são definidas uma única vez no domínio e reutilizadas na validação da aplicação e nas fábricas das entidades. As fábricas do ledger fazem cópias defensivas do estado recebido, inclusive das datas, para impedir que objetos mantidos pelo chamador alterem um lançamento existente em memória. A checagem de tipos também rejeita variáveis locais e parâmetros não utilizados.

## Representação de dinheiro

`Money` é imutável e representa unidades mínimas da moeda com `bigint`, sem conversão por `number` do JavaScript. Os valores da API e dos eventos são strings decimais com escala fixa. O PostgreSQL armazena valores exatos em `NUMERIC(20,2)`; o MikroORM os mapeia como strings e os reidrata como `Money`. Operações fora do intervalo permitido são rejeitadas, sem arredondamento. A moeda é explícita e conferida nas operações aritméticas. O desafio assume duas casas decimais para todas as moedas ISO aceitas; essa é uma simplificação deliberada, não uma implementação geral das escalas de cada moeda.

## Transações, ORM e concorrência

O MikroORM 6.6 fornece um EntityManager e um Identity Map novos por unidade de trabalho, além de `EntityManager.transactional()`. Os objetos de domínio são mapeados separadamente das entidades de persistência. `FlushMode.COMMIT` impede que consultas intermediárias provoquem a gravação de uma unidade financeira ainda incompleta. Chaves estrangeiras e triggers de integridade diferidos validam a unidade completa no commit, independentemente da ordem de inserção escolhida pelo ORM.

A ordem dos locks é: identidade da inbox, quando presente; identidades da operação em ordem; e linha da carteira com `LockMode.PESSIMISTIC_WRITE` (`SELECT FOR UPDATE`). Advisory locks serializam acessos à mesma chave de idempotência ou identidade externa, inclusive em solicitações que informam carteiras diferentes para a mesma identidade. Colisões de hash podem reduzir a concorrência, mas não enfraquecem a correção. Não há um lock global de carteiras. Carteiras distintas continuam sendo processadas de forma independente. O nível de isolamento READ COMMITTED do PostgreSQL é suficiente porque o lock da linha da carteira serializa as alterações de saldo. Novas tentativas por deadlock, conflito de serialização ou timeout de lock são limitadas a três tentativas no total, com variação aleatória no intervalo e um novo EntityManager a cada tentativa.

O banco impõe uma única carteira por `(player_id, currency)`, chaves de idempotência globais, unicidade de `(provider_id, external_transaction_id)` e um estorno processado por `(reference_transaction_id, kind)`. O conteúdo das transações terminais, os lançamentos do ledger e as linhas da inbox não podem ser alterados nem excluídos. O SQL verifica saldo não negativo, aritmética dos lançamentos, progressão de versão e consistência diferida entre saldo e ledger. As verificações diferidas do ledger conferem valor do movimento, saldo do resultado e saldo anterior. Essas proteções priorizam correção e facilidade de inspeção, com um custo de desempenho explicitado nas limitações.

## Idempotência

O header HTTP obrigatório é a fonte da verdade para a chave de idempotência. O payload canônico inclui todos os campos de negócio validados da transação, inclusive a referência quando presente. As chaves dos objetos são ordenadas recursivamente, campos opcionais com valor undefined são omitidos e arrays preservam sua ordem. O JSON em UTF-8 é resumido com SHA-256. A chave de idempotência e os metadados de transporte ficam fora desse hash. A mesma chave com o mesmo hash devolve o resultado persistido, com `idempotentReplay: true`; hash diferente produz conflito. Reutilizar o ID externo de uma transação com outra chave também produz conflito. Resultados terminais preservam o saldo observado originalmente. Resultados pendentes podem avançar para seu resultado terminal.

## Interpretações das regras de negócio

- Movimentos financeiros (`BET`, `WIN`, `REFUND`, `ROLLBACK` e `OPENING` interno) exigem valor positivo. `LOSS` aceita valor não negativo e nunca movimenta saldo.
- Saldo inicial zero cria uma carteira na versão 1, sem transação de abertura nem lançamento no ledger. Abertura positiva produz ambos na mesma transação SQL; a versão inicial permanece 1.
- Referências são IDs externos no escopo do provedor, validados contra jogador, carteira, moeda e rodada. Referências opcionais de `WIN` seguem a mesma validação de contexto e disponibilidade e devem apontar para uma BET processada. `BET` e `LOSS` não aceitam referências.
- A unicidade do estorno é **por tipo de operação**, conforme especificado: uma REFUND e uma ROLLBACK podem referenciar a mesma BET. Isso não representa uma política global de apenas um estorno por referência.
- Uma solicitação válida contra uma carteira inexistente gera rejeição de negócio auditável. Por isso, as transações de apostas não possuem uma chave estrangeira obrigatória para a carteira; os lançamentos financeiros do ledger possuem chaves estrangeiras compostas para carteira e transação.
- Uma rejeição por conflito de moeda guarda saldo de resultado nulo, para não apresentar o saldo da carteira com a moeda diferente enviada na solicitação.
- `PENDING` pode avançar para `PENDING_REFERENCE`, `PROCESSED`, `REJECTED` ou `FAILED`. `PENDING_REFERENCE` pode continuar pendente ou avançar para um dos estados terminais, mas não pode retornar a `PENDING`. Estados terminais são imutáveis. Replays não executam transições.

## Escopo da autenticação

A autenticação foi deixada fora da implementação dentro do prazo do desafio. As rotas HTTP de negócio possuem `ProviderIdentityGuard`, que delega para `ProviderIdentityPort`; o adaptador fornecido é explicitamente um no-op. Um adaptador de produção verificaria assinatura, emissor, audiência e validade de JWT OIDC usando um provedor de identidade externo, como Keycloak, e vincularia as declarações de identidade do provedor e a titularidade da carteira às regras de autorização. Criação de carteiras, consultas, reconciliação e métricas também precisam de uma política de autorização antes de exposição externa. Os endpoints de saúde permanecem abertos. SQS é tratado como transporte confiável, mas as validações de provedor e domínio continuam obrigatórias. Os namespaces `internal:` de provedor e chave são reservados e não podem ser submetidos externamente.

## Mensageria e recuperação após falhas

A chave da inbox é `(consumer_name, message_id)`. Seu hash inclui os dados de negócio validados da mensagem e a chave de idempotência, excluindo os horários do envelope e os metadados do broker. Uma mensagem com nova identidade de transporte ainda passa pela idempotência financeira; reutilizar um ID de inbox com conteúdo divergente é um conflito permanente. Uma rejeição de negócio representa um processamento concluído e confirmado, portanto recebe ack.

Estado financeiro, lançamentos do ledger, registros de inbox e eventos de integração são persistidos na mesma transação SQL. A resposta HTTP e a exclusão da mensagem SQS acontecem após o retorno de `transactional()`, que inclui o commit e a validação das constraints diferidas. Se o processo morrer antes do commit, não ficam efeitos confirmados. Se morrer depois do commit e antes do ack, a mensagem pode ser entregue novamente e será reconhecida como replay persistente.

O publisher da outbox reserva até dez linhas devidas com `FOR UPDATE SKIP LOCKED` e um lease atômico de 120 segundos. O envio acontece fora da transação de reserva. A condição que verifica o dono do lease impede que um publisher antigo marque como concluída uma reserva assumida por outro. O SDK usa duas tentativas e timeouts limitados; uma publicação que falha recebe backoff de 1 segundo até o máximo de 60 segundos. Se o publisher morrer, seu lease expira e outra instância pode assumir o trabalho. Eventos são tentados indefinidamente com atraso limitado, pois eventos financeiros confirmados não devem ser descartados; lag e tentativas precisam ser monitorados para identificar eventos que falham persistentemente.

Existe uma janela inevitável de incerteza quando o SQS aceita uma publicação, mas o PostgreSQL ainda não registrou `published_at`. Novas tentativas reutilizam o **mesmo ID e o mesmo payload do evento persistido**. A deduplicação FIFO ajuda dentro de sua janela temporal; além dela, os consumidores precisam deduplicar persistentemente por eventId. A publicação é pelo menos uma vez (at-least-once), sem garantia de entrega de rede exatamente uma vez. Publishers podem entregar eventos fora de ordem; eventos de saldo incluem `walletVersion` para o consumidor detectar ordem e versões desatualizadas.

O reprocessamento de referências usa um scanner agendado, que readquire os locks na mesma ordem de identidade e carteira usada no HTTP e relê o estado e o prazo. Scanners concorrentes não aplicam uma referência duas vezes. O padrão é atraso inicial de 1 segundo, intervalos exponenciais limitados a 60 segundos e dez tentativas de reprocessamento, aproximadamente cinco minutos até a expiração, mais o atraso de agendamento. O esgotamento produz `REJECTED / REFERENCE_EXPIRED` e evento de rejeição; novas varreduras não repetem o evento inicial de pendência.

**O PostgreSQL é a autoridade de tempo para agendamentos persistidos de retry e leases da outbox.** Comparar um prazo do banco com o relógio da aplicação pode antecipar ou paralisar workers quando houver divergência entre relógios. Por isso, verificações de prazo, cálculos de retry e lag da outbox usam o horário do banco. Horários de origem dos eventos continuam informativos. A ordenação do ledger usa a versão da carteira, não os horários de parede.

O consumidor usa long polling do SQS, processa grupos distintos em paralelo e preserva o tratamento sequencial dentro de um grupo recebido. A visibilidade é estendida durante o processamento. Falhas transitórias de infraestrutura usam backoff de visibilidade, inicialmente de 2 segundos e limitado a 60 segundos. O máximo padrão é de cinco recebimentos, com política de redrive no broker e envio explícito para DLQ pela aplicação. Envelopes malformados e conflitos de identidade imutável vão diretamente para DLQ. O envio à DLQ é confirmado antes de excluir a origem e usa uma identidade estável de deduplicação derivada da mensagem SQS original.

Quando as tentativas de infraestrutura se esgotam, uma solicitação válida é registrada como `FAILED / INFRASTRUCTURE_FAILURE`, com inbox e evento `WagerTransactionFailed`, se o PostgreSQL permitir escrita. Uma transação já confirmada devolve replay; uma falha no ack não a transforma em FAILED. Se o banco continuar indisponível, o envelope original na DLQ é a fonte durável de auditoria e recuperação; o sistema não afirma ter gravado auditoria SQL durante uma indisponibilidade do banco. A operação deve inspecionar o código estável, corrigir a causa e reenviar deliberadamente usando as identidades de negócio originais. Um registro terminal FAILED exige decisão explícita de recuperação, sem reaplicação silenciosa.

## HTTP, observabilidade e encerramento

A validação de transporte rejeita campos desconhecidos, UUIDs malformados, identidades internas reservadas, notação científica e valores sem exatamente duas casas decimais. Solicitações válidas em formato podem ser rejeitadas de forma terminal por regra de negócio, com código estável. O HTTP distingue entrada inválida (400), conflitos de identidade (409), rejeição de negócio (422), referência pendente (202), falha transitória de infraestrutura (503) e falha permanente ou interna (500). Criação usa 201; consultas usam 200 ou 404.

Logs usam uma lista restrita de IDs e códigos; requisições brutas, valores financeiros e exceções completas do SDK não são registrados. Métricas pertencem a cada processo e precisam ser coletadas em cada réplica. Contadores de submissão e retry incluem replays; o contador de duplicatas os identifica explicitamente. Registros terminais no SQL continuam sendo a fonte de auditoria. O lag da outbox usa `enqueued_at` gerado pelo banco, evitando divergências dos horários de origem dos eventos. A reconciliação usa uma única instrução SQL, portanto lê saldo armazenado e saldo reconstruído no mesmo snapshot MVCC.

Ao receber SIGTERM ou SIGINT, readiness deixa de indicar disponibilidade, long polling é interrompido e o consumidor para de iniciar novos trabalhos. Handlers e publishers em andamento têm até 30 segundos para terminar. Mensagens recebidas cujo processamento não começou têm a visibilidade devolvida a zero. Se o prazo de encerramento for excedido, os handles ativos têm a visibilidade devolvida antes do fechamento do banco e do cliente. Quedas abruptas continuam protegidas pela idempotência da inbox e pelos leases da outbox. O Compose permite 40 segundos antes do encerramento forçado. O servidor HTTP aguarda requisições em andamento antes de fechar o PostgreSQL.

## Paginação estável

Os cursores do ledger codificam um snapshot versionado e específico da carteira, com `(afterVersion, ceilingVersion)`. A versão imutável de cada lançamento ordena o histórico sem depender de desempate por horário. Novos lançamentos além do teto da primeira página ficam fora daquela sessão de paginação; uma nova sessão permite visualizá-los. O limite é de 1 a 100, com padrão 50. Os cursores são opacos para clientes, validados por tipo, limites e identidade da carteira, e não são tokens de autorização.

## Códigos de falha

| Código | Significado e ação do chamador |
|---|---|
| `INVALID_INPUT` | Corrigir contrato, valor, identificadores ou referência obrigatória antes de reenviar |
| `IDEMPOTENCY_CONFLICT` | Não reutilizar a mesma chave para outro payload |
| `EXTERNAL_ID_CONFLICT` | A transação externa já pertence a outra chave; usar a identidade original |
| `INBOX_CONFLICT` | Um ID de mensagem foi reutilizado com conteúdo divergente; investigar o remetente |
| `WALLET_EXISTS` | Consultar a carteira existente em vez de criar outra |
| `WALLET_NOT_FOUND`, `PLAYER_MISMATCH`, `CURRENCY_MISMATCH` | Corrigir o contexto de titularidade ou moeda; a identidade rejeitada continuará devolvendo replay |
| `INSUFFICIENT_FUNDS` | BET rejeitada; repetir a mesma identidade preserva a rejeição |
| `REVERSAL_INSUFFICIENT_FUNDS` | O estorno deixaria saldo negativo; é necessária intervenção operacional ou de negócio |
| `INVALID_REFERENCE`, `REFERENCE_NOT_PROCESSED` | Corrigir tipo, contexto ou estado terminal da referência |
| `REFERENCE_AMOUNT_MISMATCH` | O estorno deve ter o valor integral da referência |
| `ALREADY_REVERSED` | A referência já foi estornada por esse tipo de operação; não há novo movimento |
| `REFERENCE_EXPIRED` | A referência não ficou disponível dentro do orçamento de tentativas; investigar ausência ou ordem das operações |
| `INFRASTRUCTURE_FAILURE` | Falha permanente auditada após esgotamento das tentativas de infraestrutura |
| `INFRASTRUCTURE_UNAVAILABLE` | Código de transporte HTTP: repetir a identidade original após recuperação |
| `NOT_FOUND` | O recurso consultado não existe |

Aceitar uma referência pendente não é falha. Uma rejeição terminal não deve mudar apenas porque o saldo aumentou ou a referência ficou disponível depois. Operações de negócio corrigidas exigem novos IDs externos e novas chaves, conforme a política de recuperação do provedor.

## Escolhas e limitações

- A reconciliação diferida do ledger completo nas alterações de saldo acrescenta trabalho proporcional ao histórico da carteira. Essa proteção prioriza correção no desafio; produção exigiria medições prolongadas, um desenho contábil verificável de forma incremental e reconciliação independente. Os ensaios locais são fornecidos sem alegação de capacidade de produção ou meta de RPS.
- Cada movimento também possui um journal equilibrado de partidas dobradas: lançamento na conta de passivo da carteira e contrapartida na conta de compensação da moeda. Isso não implementa transferências entre carteiras, liquidação em contas bancárias reais, reconhecimento de receita ou estornos parciais.
- Construtores e fábricas encapsulam o domínio; triggers do PostgreSQL reforçam as garantias na persistência. O usuário local do banco é dono do schema para permitir migrations e testes reproduzíveis. Em produção, a titularidade das migrations deve ser separada de um usuário de aplicação com privilégios mínimos; um superusuário pode contornar proteções baseadas em triggers.
- Outbox, inbox e registros terminais não têm política automática de retenção ou exclusão. A decisão favorece auditoria e replay seguro, com crescimento do armazenamento. Produção exige retenção, arquivamento e backups coordenados com o período em que o provedor pode reenviar operações.
- Transações FAILED e REJECTED são terminais. A recuperação é explícita; não há endpoint administrativo que reescreva silenciosamente o histórico financeiro.
- As filas LocalStack são efêmeras nesta configuração. A outbox SQL sobrevive ao reinício dos processos, mas a perda de dados do broker **após confirmar a publicação** fica fora da garantia contra queda do processo. AWS SQS fornece durabilidade do broker; persistência ou backup local são questões operacionais.
- Autenticação e integração OIDC continuam opcionais e não foram implementadas. Partidas dobradas, tracing distribuído, dashboard provisionado e cenários de carga medidos complementam os testes de correção e recuperação.
- Versões de dependências e imagens são fixadas para reprodução. A CI é fornecida, mas uma execução local aprovada não comprova, por si só, aprovação remota no GitHub.

## Verificação

`bun run test:all` executa checagem estrita de tipos, lint, testes de domínio e testes de integração com containers reais. O runner de integração cria banco e filas exclusivos, verifica migrations nos dois sentidos e limpa apenas seus próprios recursos. Três processos reais de Bun e NestJS operam a mesma carteira; um worker é morto com SIGKILL na janela após commit e antes do ack; publishers concorrentes usam SQS real. A injeção de falhas cobre rollback antes do commit e a janela incerta entre publicar e marcar como publicado. Bancos e brokers simulados não substituem o ambiente de integração: adaptadores são envolvidos apenas para provocar falhas pontuais, mantendo PostgreSQL e SQS reais.

Os prazos de espera dos testes usam `performance.now()`, um relógio monotônico, para que ajustes de horário do host ou da VM não encerrem prematuramente as verificações de recuperação. Os agendamentos persistidos da aplicação usam, separadamente, o relógio do PostgreSQL.

## Diferenciais opcionais

### Journal de partidas dobradas

Cada `WalletLedgerEntry` produz exatamente dois `journal_postings` imutáveis na mesma unidade de trabalho: uma conta de passivo da carteira (`wallet:<id>`) com a direção do ledger e uma conta de compensação por moeda (`clearing:<currency>`) com direção oposta. Débitos e créditos são iguais por movimento e moeda. A conta compartilhada de compensação é um código contábil, não uma linha mutável de saldo global; portanto, não cria um lock global de carteiras. OPENING participa dessa regra; LOSS e transações rejeitadas ou com falha não possuem movimentos nem postings.

A migration 003 preenche as contrapartidas dos movimentos históricos sem editar o ledger original. Triggers SQL diferidos exigem exatamente dois postings iguais, com contas, moeda e lados esperados. Uma unidade financeira com carteira, transação e ledger corretos também precisa do journal equilibrado para confirmar o commit. UPDATE, DELETE e TRUNCATE do journal são proibidos. A reconciliação confere saldo da carteira, totais e quantidade de postings; respostas do ledger incluem as contrapartidas. Totais acumulados do journal permanecem strings numéricas exatas do PostgreSQL e podem ultrapassar o intervalo de um movimento individual.

### Tracing e dashboard

O tracing é instrumentado explicitamente com o SDK JavaScript do OpenTelemetry no Bun: rotas HTTP por template, unidades financeiras, consumidores SQS e publicação da outbox. O contexto W3C é extraído de HTTP ou SQS, salvo separadamente em metadados de transporte imutáveis da outbox e restaurado por outros processos publicadores. Publicações SQS carregam os headers de trace. IDs de trace e span aparecem nos logs; payloads, valores e exceções brutas ficam excluídos. Falhas tratadas de retry marcam o span ativo como falho. A instrumentação cobre as fronteiras principais, sem afirmar que toda instrução SQL é automaticamente instrumentada.

A exportação OTLP é habilitada por `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`; desativar tracing preserva o comportamento financeiro. O overlay opcional do Compose acrescenta Jaeger, Prometheus e Grafana com dashboard provisionado. O Prometheus descobre cada réplica pelo DNS do Docker, em vez de coletar repetidamente um alias balanceado como se representasse um único processo. O dashboard agrega histogramas entre réplicas e apresenta resultados, percentis de latência, duplicatas, retries, DLQ, conflitos de lock, lag, reconciliação, disponibilidade de coleta e memória. A configuração local do Prometheus aceita um minuto de amostras fora de ordem para tolerar ajustes do relógio da VM; sincronização de horário continua sendo necessária em produção.

`bun run observability:verify` verifica provisionamento do dashboard, três alvos saudáveis e um trace real que passa por HTTP, unidade financeira, tratamento SQS e publicação da outbox. O estado de Grafana e Jaeger é efêmero nesta demonstração; as configurações provisionadas são versionadas e reproduzíveis.

### Experimento de carga

`bun run test:load` é um gerador HTTP executado no Bun, em modelo fechado (closed-loop), com concorrência limitada, aproximadamente 10% de solicitações duplicadas e carteiras novas a cada execução. Foram executados os cenários de carteiras distribuídas e de uma carteira concentrando as operações (hot wallet). Os resultados incluem p50, p95 e p99 medidos no cliente, throughput, taxa de erro, variação dos conflitos de lock e amostras do lag da outbox por réplica. Após a fase cronometrada, cada carteira é conferida contra os efeitos monetários únicos esperados, as quantidades de ledger e journal e a igualdade entre débitos e créditos. Divergências encerram o script com código diferente de zero.

O experimento mede a latência local de ponta a ponta da API, com instrumentação e proteções SQL ativas. Não demonstra capacidade de produção nem um objetivo de taxa de chegada em modelo aberto. Preparação e reconciliação ficam fora da fase cronometrada. O lag da outbox é amostrado antes e depois; essas amostras não medem o pico de lag nem comprovam a latência de entrega ao consumidor. Contadores de timeout ou deadlock zerados não significam ausência de espera por locks. Ambiente, metodologia e limitações estão em `benchmarks/README.md` e nos relatórios JSON preservados.
