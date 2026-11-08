# Evidências — API-2 / SPEC-023

Execução em `spec023/api-2`, worktree `apps/bullq2/worktrees/api-spec023-2`.
Dados sintéticos; LLM e Google substituídos por doubles nos testes. Nenhuma conexão a produção.

## Preparação

- `yarn install --frozen-lockfile --non-interactive`: exit 0, lockfiles inalterados. Dockerfile usa `yarn.lock`; há também package-lock.json legado.
- `yarn prisma:generate`: exit 0; só gera cliente local, sem aplicar schema/migração.

## Vermelhos observados antes das correções

- `yarn test conversation-insights.service.spec --maxWorkers=2`: TS2307, serviço ainda inexistente.
- `yarn test calendar.conversation-insights.spec --maxWorkers=2`: TS2339, método ainda inexistente.
- `yarn test conversation-insights.http --maxWorkers=2`: 11 passam / 1 falha, GET summary retornava corpo vazio em vez de JSON null. Corrigido com resposta JSON explícita.
- `yarn test calendar.conversation-insights --maxWorkers=2`: 7 passam / 1 falha, evento legado na segunda conta acessível não era encontrado. Corrigido percorrendo contas acessíveis; 404 de conta desconhecida não implica cancelamento.
- Após a última alteração, TS2345 apontou eventId anulável; corrigido por narrowing explícito antes da consulta externa.

## Teste PostgreSQL descartável

O teste exige `SPEC023_TEST_PG_URL` apontando ao usuário/host/porta/banco abaixo. Não herda DATABASE_URL.

```sh
mkdir -p tmp
initdb -D tmp/spec023-pg --no-locale -A trust -U spec023
pg_ctl -D tmp/spec023-pg -l tmp/spec023-pg.log -o "-h 127.0.0.1 -p 55439 -k ''" start
createdb -h 127.0.0.1 -p 55439 -U spec023 spec023_test
SPEC023_TEST_PG_URL=postgresql://spec023@127.0.0.1:55439/spec023_test yarn test conversation-insights --maxWorkers=2 --detectOpenHandles
pg_ctl -D tmp/spec023-pg stop -m fast
```

Resultado: **4 suítes / 53 testes passam**, exit 0, sem handles abertos reportados no diagnóstico. A leitura de mensagens e o LLM são doubles; reserva e persistência JSONB usam PostgreSQL real. Dois cliques simultâneos: 1 geração e 1 HTTP 429. Falha do provedor mantém a janela de um minuto; retry depois da janela passa. Campos concorrentes do JSON são preservados.

Uma execução paralela anterior passou os mesmos 53 testes, mas avisou que um worker foi encerrado à força. A repetição com `--detectOpenHandles` passou sem aviso; a causa daquele aviso não foi comprovada.

## Lint reproduzível dos arquivos tocados

O repositório não fornece script nem configuração de lint. Executado gate explícito com ferramentas temporárias, sem mudar package.json/lockfiles:

```sh
mkdir -p tmp
cat > tmp/spec023-eslint.config.cjs <<'JS'
const ts = require('typescript-eslint');
module.exports = [
  ...ts.configs.recommended,
  { files: ['**/*.ts'], rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  } },
];
JS
npm exec --yes --package=eslint@9.39.1 --package=typescript-eslint@8.48.1 -- sh -c 'NODE_PATH="$(dirname "$(dirname "$(command -v eslint)")")" eslint --config tmp/spec023-eslint.config.cjs src/modules/conversation-insights/*.ts src/modules/calendar/calendar.service.ts src/modules/calendar/calendar.conversation-insights.spec.ts src/app.module.ts'
```

Resultado: exit 0, sem erros/avisos. `no-explicit-any` desligado para compatibilidade com o Calendar existente; não é declaração de lint canônico global. Uma constante CAL_SCOPE já sem uso foi removida do arquivo tocado para passar no gate de variáveis sem uso.

## Limites da prova

A integração web, Google/LLM reais, banco completo da aplicação, ambiente multi-réplica real, revisão independente e aceite humano não foram exercitados. A exclusão mútua foi exercitada no PostgreSQL local real, com chamadas concorrentes ao serviço. Não houve push, deploy, migração aplicada nem edição de prisma/schema.prisma.

## Gates finais do checkout

- `SPEC023_TEST_PG_URL=postgresql://spec023@127.0.0.1:55439/spec023_test yarn test --maxWorkers=2`: exit 0; `Test Suites: 5 skipped, 147 passed, 147 of 152 total`; `Tests: 49 skipped, 1351 passed, 1400 total`; `Time: 59.544 s`. Sem aviso de worker/handles nessa execução final.
- `yarn typecheck --incremental false`: `tsc --noEmit --incremental false`, exit 0.
- `yarn build`: `nest build`, exit 0.
- `git diff --check`: sem saída, exit 0.
- `git diff 55e019e -- prisma/schema.prisma`: sem saída, schema preservado.
- `pg_ctl -D tmp/spec023-pg stop -m fast`: `server stopped`, exit 0.
