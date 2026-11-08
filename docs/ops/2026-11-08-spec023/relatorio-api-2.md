# Relatório final — API-2 / SPEC-023

Setor implementado no branch `spec023/api-2`, base `55e019e`. Validação local; revisão independente e integração pertencem à sessão principal.

## Funções entregues

- **F2:** GET `/conversations/:id/messages/search` pesquisa texto/caption/subject/body/fileName do JSON, ignorando caixa e acentos; snippet com offsets no texto original; limit 1–50; cursor por ID da mesma conversa ou ISO. Varredura em lotes de 200 até completar a página ou esgotar mensagens. GET `/conversations/:id/messages/around/:messageId` retorna `{items: Message[]}` em ordem cronológica, incluindo o alvo; padrão 40, máximo 50. Mensagens revogadas são excluídas.
- **F5:** GET `/conversations/:id/attachments`, filtros all/image/video/audio/document, paginação determinística; nome/MIME/tamanho quando presentes; mediaPath aponta ao resolvedor existente `/messages/:id/media`. Não chama o provedor para montar o índice.
- **F6:** GET `/conversations/:id/meetings` lê bolhas SYSTEM vinculadas à conversa. Consulta os eventos exatos no Google por canais da organização acessíveis ao membro. Bolhas novas guardam eventId, canal/calendário e snapshot completo em metadata. Bolhas antigas são reconhecidas pelo metadata anterior ou texto; se a conta criadora não foi guardada, procura nas contas acessíveis. Sem conexão, mantém os dados da bolha. Não inventa dados ausentes.
- **F3:** GET summary sem gerar nada, com JSON null quando ausente e stale se houve criação/ingestão posterior. POST explícito gera resumo em quatro seções; usa AiLlmRouterService, ProviderResolverService e credenciais da organização. Escolhe modelo econômico por provedor, sem herdar override caro. Até 200 mensagens, payload textual até 16.000 bytes UTF-8 e prompt completo abaixo de 20.000 tokens de entrada; saída até 1.000 tokens. Conteúdo das mensagens vai em JSON no papel user; instruções fixas no system tratam-no como dados não confiáveis. Sem ferramentas, envio ou alteração de aiEnabled. Erro de provedor/JSON inválido resulta em 502 visível, sem resumo inventado.

Todas as rotas usam JwtAuthGuard, OrgGuard e RolesGuard; organização vem de CurrentOrg, acesso de CurrentChannelAccess. Consultas de mensagens também restringem a organização. Conversas excluídas, extras fundidas, cursores e alvos de outra conversa são recusados. Resumo e reserva de um minuto são gravados como folhas JSONB, preservando o restante do metadata. A reserva é atômica no PostgreSQL, vale entre processos e não pode ser burlada por force nem falha do provedor; nenhum estado por schema novo.

## Arquivos e commits

- `31d91db feat(calendar): add scoped conversation meeting history`
  - `src/modules/calendar/calendar.service.ts`
  - `src/modules/calendar/calendar.conversation-insights.spec.ts`
- `74e4dd1 feat(conversations): add search attachments and on-demand summaries`
  - `src/modules/conversation-insights/conversation-insights.{module,controller,service}.ts`
  - `src/modules/conversation-insights/conversation-insights.{service,http,pg}.spec.ts`
  - `src/app.module.ts` (import e registro do módulo; possível ponto de merge com API-1).
- Evidências reproduzíveis em `verification-evidence-api-2.md`, nesta pasta.

Commits locais, hooks habilitados, sem --no-verify. Schema e lockfiles inalterados.

## Verificação

Ver `verification-evidence-api-2.md` para comandos completos, vermelhos observados, preparação do PostgreSQL e configuração temporária do lint.

| Comando | Saída resumida | Conclusão |
| --- | --- | --- |
| `yarn install --frozen-lockfile --non-interactive` | exit 0; lockfiles inalterados | Dependências instaladas pelo lock usado no Dockerfile. |
| `yarn prisma:generate` | Prisma Client 6.19.3 gerado, exit 0 | Cliente local disponível; sem migração aplicada. |
| `SPEC023_TEST_PG_URL=postgresql://spec023@127.0.0.1:55439/spec023_test yarn test conversation-insights --maxWorkers=2 --detectOpenHandles` | 4 suítes, 53 testes passam; exit 0 | Busca, around, anexos, reuniões, resumo, HTTP local e reserva JSONB concorrente. Sem handles abertos no diagnóstico. |
| `yarn typecheck --incremental false` | tsc --noEmit, exit 0 | Tipos do checkout limpos. |
| `yarn build` | nest build, exit 0 | Build completo passa. |
| ESLint 9.39.1 + typescript-eslint 8.48.1, config/comando em verification-evidence | exit 0, sem erros/avisos | Lint explícito dos arquivos tocados. O repo não possui gate canônico de lint. |
| `git diff --check` | sem saída, exit 0 | Diff sem problemas de whitespace. |
| `git diff 55e019e -- prisma/schema.prisma` | sem saída | Schema preservado. |

Execução final: `SPEC023_TEST_PG_URL=postgresql://spec023@127.0.0.1:55439/spec023_test yarn test --maxWorkers=2` → **147 suítes passam, 5 ignoradas; 1.351 testes passam, 49 ignorados**, exit 0, 59,544 s de Jest. Sem aviso de worker/handles nessa execução. Os testes ignorados já pertencem ao checkout e exigem suas condições próprias.

`pg_ctl -D tmp/spec023-pg stop -m fast` → server stopped, exit 0. Cluster descartável encerrado; arquivos locais de prova permanecem em tmp/ ignorado.

## Pendências, riscos e integração

- **Sem bloqueio estrutural.** F2/F3/F5/F6 estão implementadas e têm testes locais. Revisão independente, integração API-1/WEB-2, smoke real e aceite humano ficam com o integrador; este relatório não os declara aprovados.
- O Google e o LLM foram testados com doubles; não houve chamada real, cobrança ou uso de banco de produção. O PostgreSQL real foi descartável, com tabela mínima para exercitar a reserva/persistência JSONB, não o banco completo do produto.
- Busca sem acento percorre o histórico em lotes porque não exige extensão nem migração; conversas muito grandes podem custar leituras proporcionais ao histórico. O volume de produção não foi medido.
- Em bolhas antigas desconectadas, `start` pode ser o texto localizado original; end/eventId podem ser null, attendees vazio e status unknown. Sem identidade histórica da conta Google, 404 não é tratado como cancelamento certo. WEB-2/integrador avisados em cross-requests.md para exibir a informação disponível.
- Os adapters Kimi e Fugu existentes só oferecem seu modelo padrão no catálogo local; os demais usam modelos econômicos explícitos. Disponibilidade e comportamento dos provedores reais precisam do smoke de integração.
- Um worker avisou encerramento forçado em execução paralela; a repetição com diagnóstico passou limpa. Causa do aviso não comprovada.
- O integrador consolida o devlog e o handoff do projeto. Esta sessão fez `devlog ver`; não publicou anotações paralelas no painel.

COMPANION_COMPLETE companion-spec023-api-2-1


## Rodada de correção pós-QA

08/11/2026, companion `companion-spec023-api-2-fix-1`, worktree `api-spec023-2`, branch `spec023/api-2`. Base da rodada: `d948a87`. Correção implementada e verificada localmente; este registro não constitui novo parecer de QA independente.

### Achados e resultado

- **A2-1 corrigido:** busca com no máximo 25 lotes de 200 mensagens (5.000 linhas) por requisição, `select` restrito a seis campos do contrato e texto. Ao atingir o teto, devolve `nextCursor` da última mensagem varrida, inclusive com zero resultados; a próxima chamada continua a busca. Quando há um resultado excedente, o cursor continua sendo o último resultado entregue, preservando o excedente. Formato da SPEC §3 preservado. Teste com 5.200 mensagens sintéticas comprova 25 consultas, página vazia com cursor e encontro do termo raro na chamada seguinte, sem perda.
- **A2-2 corrigido:** filtro no banco por `metadata.kind = calendar_scheduled` OU prefixo textual da bolha antiga; `take:100`, ordenação determinística e seleção de somente id/createdAt/content/metadata. Falha de token, 401, 429 ou 5xx preserva o snapshot daquele item, com `status:unknown`, e permite atualizar as outras reuniões. 404/410 continuam indicando cancelamento somente quando a conta criadora é conhecida. Log de falha inclui apenas evento e status HTTP numérico, quando disponível. Testes verificam a consulta limitada e a degradação por item. A lista cobre as 100 bolhas de reunião mais recentes; chamadas externas continuam sequenciais, opção de paralelismo sugerida pelo QA não aplicada nesta correção para manter o diff restrito e evitar rajada de requisições.
- **A2-3 invariável comprovada, divergência do QA reconciliada:** no checkout desta rodada, `completeWithProvider` chama `resolveProvider`, que executa `lookupCredential(organizationId, provider, null)`. Portanto `dispatch` recebe `modelOverride:null`, mesmo quando `resolveForLlm` encontrou override caro. O teste novo instancia **resolver e router reais**, simula apenas persistência/credencial e adapter, configura `expensive-model` no roteamento da organização e verifica `gpt-4o-mini` no adapter. Passava já antes da correção; não foi necessário alterar contrato compartilhado, router nem resolver. Comentário no serviço registra a razão. Não se declara smoke real ou confirmação de disponibilidade dos modelos Kimi/ZAI/Qwen.
- **A2-4 corrigido:** log estruturado `conversation_summary_failed` com etapa (`credentials`, `provider`, `completion`, `json`, `sections`), tipo de erro em lista fechada e status HTTP numérico válido, quando disponível. Nenhum corpo, mensagem livre do SDK, stack, chave ou conteúdo da conversa no log deste catch. Cliente continua recebendo 502 visível. Teste verifica causa 401 e ausência dos dados sensíveis sintéticos no log.
- **A2-5 corrigido:** POST sem corpo/sem force ou `force:false` devolve resumo salvo quando não stale, sem LLM nem reserva. `force:true`, resumo inexistente ou stale geram como antes, respeitando a reserva atômica de um minuto. Testes cobrem as três formas de reuso e regeneração forçada ou por stale; os testes PostgreSQL de concorrência e falha continuam passando.
- **A2-6 mantido com motivo:** falha de provedor continua consumindo a janela de um minuto, conforme brief e proteção de custo. Localizado escritor do objeto completo em `src/modules/messaging/pipeline/history-import.service.ts:134-147` (`existing.metadata` → `data.metadata` → `conversation.update`): existe risco de sobrescrever folha concorrente, mas a corrida não foi reproduzida nesta rodada. Corrigir globalmente todos os escritores ultrapassa o setor e exige auditoria própria. A prova PostgreSQL atesta preservação de folhas escritas concorrentemente via JSONB, não segurança de todos os escritores da aplicação.
- **A2-7 preservado:** bolhas legadas podem ter eventId nulo e início localizado. Inventar id/fuso seria incorreto; mantém-se a limitação já comunicada a WEB-2/integrador no relatório anterior.

### Comandos e saídas

Todos os comandos de código e Git foram executados no worktree do setor. O apêndice foi também anexado ao relatório no caminho absoluto indicado pelo brief, sem alteração de código fora do worktree. Logs completos locais em `tmp/spec023-fix-*.log` (ignorados pelo Git).

| Comando | Saída resumida |
| --- | --- |
| `pwd` / `git branch --show-current` | worktree exato solicitado; `spec023/api-2` |
| `devlog ver` | card BullQ / Synq consultado; nenhuma anotação paralela de entrega (consolidação pelo integrador) |
| `yarn test conversation-insights.service calendar.conversation-insights --maxWorkers=2` antes da implementação | 2 suítes falham; 11 testes falham, 41 passam; Yarn exit 1. Log: `tmp/spec023-fix-red.log` |
| Mesmo comando após implementação | 2 suítes / 52 testes passam; exit 0 |
| `pg_ctl -D tmp/spec023-pg -l tmp/spec023-pg.log -o "-h 127.0.0.1 -p 55439 -k ''" start` | `server started`; cluster descartável criado na rodada anterior, sem produção |
| `SPEC023_TEST_PG_URL=postgresql://spec023@127.0.0.1:55439/spec023_test yarn test conversation-insights calendar --maxWorkers=2 --detectOpenHandles` | 4 suítes / 66 testes passam; exit 0; 7,267 s. Inclui 2 testes com reserva/persistência JSONB em PostgreSQL real |
| `yarn typecheck --incremental false` | `tsc --noEmit --incremental false`; exit 0 |
| `yarn build` | `nest build`; exit 0 |
| ESLint explícito com comando abaixo | sem saída; exit 0 |
| `SPEC023_TEST_PG_URL=postgresql://spec023@127.0.0.1:55439/spec023_test yarn test --maxWorkers=2` | 147 suítes passam, 5 ignoradas; 1.364 testes passam, 49 ignorados (1.413 totais); exit 0; 24,038 s; sem aviso de worker encerrado |
| `git diff --check` | sem saída, exit 0 |
| `git diff 55e019e -- prisma/schema.prisma` | sem saída; schema preservado |
| `pg_ctl -D tmp/spec023-pg stop -m fast` | `server stopped`; exit 0 |

Lint reproduzido com a configuração temporária já descrita em `verification-evidence-api-2.md`:

```sh
npm exec --yes --package=eslint@9.39.1 --package=typescript-eslint@8.48.1 -- sh -c 'NODE_PATH="$(dirname "$(dirname "$(command -v eslint)")")" eslint --config tmp/spec023-eslint.config.cjs src/modules/conversation-insights/*.ts src/modules/calendar/calendar.service.ts src/modules/calendar/calendar.conversation-insights.spec.ts src/app.module.ts'
```

Sem script/config canônicos de lint no checkout; o comando acima é um gate explícito dos arquivos tocados, não lint global. Warnings existentes do Yarn: ausência de licença e colisão de dependência `ajv` no package pai; nenhum erro de tipos/build.

### Commits e próximo passo

- `8a611e4 fix(calendar): bound meeting history and degrade provider failures`
- `5d227ee fix(conversations): cap search scans and reuse fresh summaries`

Commits locais com hooks habilitados, sem `--no-verify`; nenhuma edição em schema, lockfiles, regras ou estado compartilhado; nenhum push, deploy, migração ou acesso a banco de produção. Runtime `.aiox/` fica fora dos commits. Sem bloqueio estrutural.

Próximo passo do integrador: revisar `git show 8a611e4` e `git show 5d227ee`, repetir QA independente sobre este HEAD e integrar API-1/WEB-2. Smoke real de Google/LLM, performance com volume de produção e aceite humano continuam pendentes; os testes usam doubles nessas fronteiras. Esta rodada fecha correções locais e relatório, sem declarar entrega em produção.

COMPANION_COMPLETE companion-spec023-api-2-fix-1
