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
