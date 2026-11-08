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
