# Evidência — API-1 / SPEC-023

Fonte principal: relatorio-api-1.md (comandos, saídas, matriz e limites).

## Suíte final (exit 0)

```sh
yarn test --maxWorkers=2 --silent
```

```text
Test Suites: 5 skipped, 147 passed, 147 of 152 total
Tests:       49 skipped, 1341 passed, 1390 total
Snapshots:   0 total
Time:        71.424 s
Done in 75.57s.
```

Aviso observado: worker sem encerramento gracioso; origem não atribuída. Não equivale a aceite de runtime.

## Bateria direcionada final (exit 0)

```sh
yarn test conversation-workspace conversation-mute clickup-incorporation-access clickup-inbox-workbench-w3 merged-redirect --maxWorkers=2 --silent
```

```text
Test Suites: 6 passed, 6 total
Tests:       73 passed, 73 total
Snapshots:   0 total
Time:        21.934 s
Done in 31.15s.
```

## Tipos

```text
yarn run v1.22.22
warning package.json: No license field
warning ../../../../package.json: "dependencies" has dependency "ajv" with range "^8.17.1" that collides with a dependency in "devDependencies" of the same name with version "^8.20.0"
$ tsc --noEmit --incremental false
Done in 34.98s.

```

Exit 0. Lint: comando ausente, exit 1; sem alegação de lint limpo. Prisma validate válido com DATABASE_URL e DIRECT_URL fictícias; diff de schema contém só muted_until. Nenhuma migração aplicada.
