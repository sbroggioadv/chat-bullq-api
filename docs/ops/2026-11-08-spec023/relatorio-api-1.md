# Relatório API-1 — SPEC-023 — 08/11/2026

Implementação local de F1, F4 e F8 entregue; investigação e correções API de F9 entregues. Testes e tipos confirmados no worktree `api-spec023-1`, branch `spec023/api-1`. **Prontidão integral não declarada:** lint não existe no checkout, integração web, revisão independente e aceite real seguem pendentes.

## Entregas

- **F1:** `PATCH /conversations/:id/mute` aceita 1h/8h/24h/forever/off, devolve id e mutedUntil ISO/null, audita e emite conversation:updated. Campo nullable no payload normal de Conversation. A notificação é barrada antes de gravar/enfileirar e reavaliada na entrega do job. Os dois message:new recebem mutedUntil e suppressNotifications sem suprimir mensagem inbound, chamada de IA ou contagem de não lidas. Não há implementação de push externo neste backend; a entrega existente é notification:new via WS. A web atual também não contém disparador de som/desktop de mensagem; alinhamento registrado com WEB-1.
- **F4:** GET/POST/PATCH/DELETE de notas no contrato da SPEC, conteúdo de 1 a 4000 caracteres, autor e nome, ordem decrescente determinística, edição/exclusão só pelo autor. Gravação e audit-log na mesma transação. Usa InternalNote existente, sem migração de notas e sem entrar no pipeline de mensagens/provedor.
- **F8:** lista WhatsApp/Gmail acessíveis, current, conversa encontrada, available e reason; abre/reusa conversa do mesmo contato ou cria identidade e conversa atomicamente. Lock igual ao do resolvedor inbound evita duplicação. Reuso inclui arquivadas, exclui extras fundidas; grupos nunca trocam canal nem criam duplicadas nesse endpoint. Gmail é aberto para o composer de e-mail já existente, pois o adapter genérico de /messages recusa Gmail. WEB-1 confirmou uso de /email/compose.
- **F9:** causa do erro de texto reproduzida: web enviava kind=attachment para texto sem URL; API responde 422 “mensagem sem arquivo para anexar”. TEXT consta no enum permitido; a rejeição é por ausência de URL, não pelo enum. kind=comment funciona no simulador. Pedido enviado a WEB-1, que confirmou a correção. Na API foram acrescentadas verificações de canal às duas rotas incorporations e recusa de conversa fundida antes de efeitos externos. Testes existentes de leitura local/S3 e confirmação por releitura foram preservados.

## Commits locais

1. `45c227a` — schema/SQL, silêncio de alertas e sinalização realtime.
2. `6209ce7` — rotas e serviço de silêncio, notas e canais; testes unitários e HTTP.
3. `e024910` — fronteiras de incorporação ClickUp e regressões.

Sem push, deploy, aplicação de SQL, banco de produção ou chamadas reais a provedores.

## Verificação: comando + saída + conclusão

Dependências instaladas com `yarn install --frozen-lockfile --non-interactive` (exit 0; `Done in 21.13s`). Dockerfile usa yarn.lock. Há também package-lock.json/CI npm; nenhum lockfile foi alterado.

`./node_modules/.bin/prisma generate` → exit 0, `Generated Prisma Client (v6.19.3)`. Gera apenas o cliente local.

`yarn test conversation-workspace conversation-mute clickup-incorporation-access clickup-inbox-workbench-w3 merged-redirect --maxWorkers=2 --silent` → exit 0:

```text
Test Suites: 6 passed, 6 total
Tests:       73 passed, 73 total
Snapshots:   0 total
Time:        21.934 s
Done in 31.15s.
```

Conclusão: F1/F4/F8, rotas HTTP, autorização F9, mídia/recibos F9 e regressão inbound cobertos localmente. O teste HTTP usa controller/serviço/OrgGuard/RolesGuard/ChannelAccessService reais, JWT substituído e Prisma simulado. A concorrência usa um lock serial simulado; não prova Redis distribuído real.

`yarn test --maxWorkers=2 --silent` → exit 0, no código final:

```text
Test Suites: 5 skipped, 147 passed, 147 of 152 total
Tests:       49 skipped, 1341 passed, 1390 total
Snapshots:   0 total
Time:        71.424 s
Done in 75.57s.
```

A suíte completa emitiu: `A worker process has failed to exit gracefully and has been force exited.` A origem não foi atribuída nem tratada como falha preexistente comprovada. Nenhum timeout foi aumentado, nenhum teste foi desativado e não se usou --forceExit para fabricar verde. Os 49 testes ignorados já pertencem à suíte; não houve mudança de skip.

`yarn typecheck --incremental false` → exit 0, `tsc --noEmit --incremental false`, `Done in 34.98s`. Tipos limpos.

`DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused DIRECT_URL=postgresql://unused:unused@127.0.0.1:1/unused ./node_modules/.bin/prisma validate` → exit 0, `The schema at prisma/schema.prisma is valid`. A primeira tentativa sem DIRECT_URL falhou P1012; repetida com ambas as URLs fictícias, sem conectar a banco.

`git show 55e019e:prisma/schema.prisma > /tmp/spec023-api1-baseline.prisma` seguido de `./node_modules/.bin/prisma migrate diff --from-schema-datamodel /tmp/spec023-api1-baseline.prisma --to-schema-datamodel prisma/schema.prisma --script` → diff apenas `ALTER TABLE "conversations" ADD COLUMN "muted_until" TIMESTAMP(3);`. Diff de datamodel, não aplicação de migração. O SQL entregue coincide semanticamente com esse diff; desfazer remove a coluna e perde o estado de silêncio, exigindo o gate de produção da SPEC.

`git diff --check` → exit 0, sem saída.

`yarn lint --no-fix` → exit 1, `error Command "lint" not found.` **Lint não verificado.** A ausência também foi conferida no package.json e na busca de configuração/executável. Encaminhado em perguntas-api-1.md; não foi criada configuração ad hoc nem ampliado o escopo T2.

## Negativos e limites

- Rotas novas começaram sem implementação: testes iniciais falharam por módulo/métodos ausentes; não se apresenta isso como prova comportamental de base.
- F9 teve red comportamental antes da correção: `yarn test clickup-incorporation-access --maxWorkers=2 --silent` falhou 2/2 porque o controller resolvia `{ok:true}` para canal sem acesso. Depois da correção os mesmos casos passaram.
- A primeira suíte ampla apontou 13 falhas em três fixtures sem o novo método do gateway. Os mocks foram atualizados com o retorno explícito do método, preservando as assertivas, e a suíte final passou.
- Matriz coberta: feliz, vazio, inválido, erro, reuso/idempotência, concorrência local, autorização, regressão e HTTP local. ClickUp, WhatsApp, Gmail, Redis e PostgreSQL reais não foram exercitados. Não se declara aceitação ponta a ponta em produção.
- Conteúdo de notas fica fora do provedor; nenhum segredo foi logado ou incluído nos artefatos.

## Arquivos alterados

- `prisma/migrations/20261108000000_conversation_mute/desfazer.sql`
- `prisma/migrations/20261108000000_conversation_mute/migration.sql`
- `prisma/schema.prisma`
- `src/modules/clickup-inbox/clickup-inbox-group.controller.ts`
- `src/modules/clickup-inbox/clickup-inbox-workbench-w3.service.spec.ts`
- `src/modules/clickup-inbox/clickup-inbox-workbench.controller.ts`
- `src/modules/clickup-inbox/clickup-inbox.service.ts`
- `src/modules/clickup-inbox/clickup-inbox.test-harness.ts`
- `src/modules/clickup-inbox/clickup-incorporation-access.spec.ts`
- `src/modules/messaging/conversations/conversation-workspace.controller.ts`
- `src/modules/messaging/conversations/conversation-workspace.http.spec.ts`
- `src/modules/messaging/conversations/conversation-workspace.service.spec.ts`
- `src/modules/messaging/conversations/conversation-workspace.service.ts`
- `src/modules/messaging/messages/inbound-media-mirror.hardening.spec.ts`
- `src/modules/messaging/messages/inbound-media-mirror.spec.ts`
- `src/modules/messaging/messaging.module.ts`
- `src/modules/messaging/pipeline/inbound-message.processor.ts`
- `src/modules/messaging/pipeline/merged-redirect.spec.ts`
- `src/modules/notifications/conversation-mute.spec.ts`
- `src/modules/notifications/conversation-mute.ts`
- `src/modules/notifications/notification.fronteira.spec.ts`
- `src/modules/notifications/notification.processor.ts`
- `src/modules/notifications/notifications.service.ts`
- `src/modules/realtime/realtime.gateway.ts`

## Próximos passos do integrador

1. Revisão independente do branch e encaminhamento do lint canônico; investigar o aviso de encerramento de worker sem presumir origem.
2. Integrar os setores web, testar os contratos com PostgreSQL/Redis de teste e provedores autorizados e realizar smoke visual. Consultar cross-requests.md do workspace pai para Gmail e F9.
3. Migração e deploy apenas nas etapas da SPEC, com dump e CONFIRMO próprios. Os arquivos SQL estão em prisma/migrations/20261108000000_conversation_mute/ e não foram aplicados.

COMPANION_COMPLETE: companion-spec023-api-1-1

## Rodada de correção pós-QA

Branch `spec023/api-1`, worktree `api-spec023-1`, correção em commit local `6e271a8`. Esta seção atualiza o comportamento de F1 descrito anteriormente: somente `NEW_MESSAGE` é suprimido; alertas operacionais continuam sendo registrados/enfileirados/entregues.

### Achados tratados e limites

- **A1-1 corrigido:** lookup de silêncio protegido no inbound após persistir; em falha registra aviso estruturado, usa `mutedUntil:null` e `suppressNotifications:false` e segue realtime/chatbot/IA. O helper canônico também trata falha de consulta para proteger gateway, criação e entrega de notificações; o catch do inbound mantém a fronteira segura caso o método do gateway rejeite. Logs não incluem corpo de mensagem nem erro bruto com possível dado de conexão.
- **A1-2 corrigido conforme decisão do integrador:** somente `NEW_MESSAGE` consulta silêncio. SLA, transferência/atribuição da IA, falha operacional da IA e SYSTEM são persistidos e entregues mesmo silenciados. Confirmados os tipos reais usados por `sla-timer`, `watchdog` e `transfer-to-human` (`CONVERSATION_ASSIGNED`/`AI_TOOL_FAILURE`). Testes cobrem esses tipos, além de `CONVERSATION_TRANSFERRED`.
- **A1-3 registrado, sem alterar produto:** silêncio continua global da conversa, compartilhado por todos os agentes com acesso ao canal, conforme a SPEC. Não foi criada tabela nem preferência por usuário.
- **A1-4 corrigido:** o filtro inclui o canal atual mesmo fora dos tipos trocáveis; organização, canal ativo no cadastro (`deletedAt:null`) e acesso continuam obrigatórios. Instagram atual retorna `current:true`, `available:false` e motivo explícito; open segue recusado.
- **A1-5 pendente de evidência real:** montagem de `externalId` não alterada. Checklist do dado de produção necessário em `perguntas-api-1.md`, também registrado no caminho absoluto solicitado do workspace pai. Nenhum dado real consultado ou copiado.
- **A1-6 aceito nesta rodada:** notas continuam sem paginação/teto, como permite a SPEC. Limitar a 200 sem cursor esconderia notas antigas; demanda de paginação fica para escopo próprio se volume justificar.
- **A1-7 corrigido:** `desfazer.sql` usa `DROP COLUMN IF EXISTS`. Arquivo inspecionado; SQL não aplicado nesta rodada, nem em banco local.

### Verificação — comandos e saídas

1. **Vermelho antes do código:** `yarn test conversation-mute merged-redirect conversation-workspace.service --maxWorkers=2 --silent` → exit 1; `3 failed` suites; `7 failed, 47 passed, 54 total`. Inbound rejeitou com `db_timeout` depois de persistir; quatro tipos operacionais não criaram registro; notify rejeitou `db`; filtro do canal atual excluía Instagram. Log local: `/tmp/spec023-api1-fix-red.log`.
2. **Verde após correção:** mesmo comando → exit 0; `3 passed`; `54 passed`. Depois foram acrescentados os dois tipos efetivos usados pela transferência da IA, sem mudar produção. Log: `/tmp/spec023-api1-fix-green.log`.
3. **Direcionados finais:** `yarn test conversation-workspace conversation-mute clickup-incorporation-access clickup-inbox-workbench-w3 merged-redirect inbound --maxWorkers=2 --silent` → exit 0; `1 skipped, 10 passed, 10 of 11 total`; `26 skipped, 189 passed, 215 total`; `Time: 9.937 s`. Log: `/tmp/spec023-api1-fix-targeted-final.log`.
4. **Tipos finais:** `yarn typecheck --incremental false` → exit 0; `tsc --noEmit --incremental false`; `Done in 14.75s`.
5. **Suíte completa com os nove novos casos:** `yarn test --maxWorkers=2 --silent` → exit 0; `5 skipped, 147 passed, 147 of 152 total`; `49 skipped, 1350 passed, 1399 total`; `Time: 23.366 s`; `Done in 25.34s`. Log: `/tmp/spec023-api1-fix-full.log`. Nesta execução não ocorreu aviso de worker forçado; isso não diagnostica a execução anterior.
6. `git diff --check` → exit 0, sem saída. Lint continua não verificado: o package.json atual não define script lint; sem introduzir configuração ad hoc.

Nenhum skip, assertiva preexistente ou timeout foi relaxado para passar. O teste novo de falha do inbound exercita process real e persistência simulada, verifica as duas emissões realtime, fila de chatbot, chamada de IA e conclusão do webhook; não prova Redis/PostgreSQL/provedor real. Não houve push, deploy, migração aplicada, consulta de produção ou `--no-verify`. Pronto para nova revisão independente do integrador, sem declarar aceite de produção. Não surgiu decisão estrutural indispensável nem foi simulada aprovação.

COMPANION_COMPLETE: companion-spec023-api-1-fix-1
