# Migration Drift Sweep — S18/Wave 4/W4-A

**Data:** 2026-05-16
**Agente:** agent-cto + database-engineer
**Branch:** `fix/s18-w4a-migration-drift-sweep`
**Migration gerada:** `20260516180000_drift_sweep_w4a`

## Contexto

Após o bug do Jarvis (2026-05-16 manhã, 5 colunas em `ai_agents` no schema mas não no DB), risco sistêmico identificado: outras tabelas podem ter drift latente do merge upstream JP de 2026-05-13 (43 commits). Esta sprint W4-A audita **toda** a divergência schema.prisma ↔ migrations history e gera uma única migration aditiva pra alinhar prod.

## Método

Fonte autoritativa: `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url <pg-virgem> --script`.

Esse comando:
1. Aplica todas as 34 migrations em um Postgres virgem (shadow DB);
2. Lê o estado resultante e compara com `schema.prisma`;
3. Gera o SQL EXATO que falta pra alinhar.

Output vazio = zero drift. Output com SQL = drift que precisa virar migration.

## Achados — 6 itens de drift

| # | Tipo | Localização | Severidade | Causa provável |
|---|------|-------------|-----------|----------------|
| 1 | Enum value faltante | `NotificationType.AI_TOOL_FAILURE` | **CRÍTICO** | Adicionado ao schema durante merge JP 2026-05-13; sem migration formal. Qualquer tentativa de criar Notification do tipo crashava com Postgres `invalid input value for enum`. |
| 2 | Column nullability | `channels.ai_enabled` | **ALTO** | Schema mudou pra `Boolean?` (tristate, NULL=segue org) mas migration `20260508120000` criou `BOOLEAN NOT NULL DEFAULT true`. Código TS tratava como nullable, INSERT sem valor falhava. |
| 3 | Index faltante | `idx_ai_agent_org_dept` (organization_id, department) | MÉDIO | Schema declarou `@@index([organizationId, department])` no merge JP; sem migration. Queries de "listar agentes do setor X" sem index = table scan. |
| 4 | Index name drift | `ai_agents_parent_agent_id_idx` → `idx_ai_agent_parent` | BAIXO | Migration `20260516130000_ai_agents_org_tree` (criada hoje) usou nome auto-Prisma; schema declarou `name:` custom. Funcional, mas Prisma flagging como drift. |
| 5 | FK ON UPDATE missing | `messages_revoked_by_fkey` | BAIXO | Migration criou `ON DELETE SET NULL` sem `ON UPDATE CASCADE`. Schema espera default Prisma. Risco real só se PKs de users forem alterados (raro, mas drift cosmético). |
| 6 | Index name drift | `organization_credential_audits_org_created_idx` → padrão Prisma | BAIXO | Migration `20260515160000` (Wave 2) usou nome custom curto; schema usa nome auto-Prisma. Cosmético. |

**Resumo severidade:** 1 CRÍTICO + 1 ALTO + 1 MÉDIO + 3 BAIXO = **6 drifts encontrados, todos corrigidos numa única migration aditiva**.

## Migration Gerada

`prisma/migrations/20260516180000_drift_sweep_w4a/migration.sql`

Características:
- **Idempotente** em todos os 6 blocos (`IF NOT EXISTS`, `IF EXISTS`, ou DO block com check em catalog).
- **Aditiva/cosmética**: não toca dados, não bloqueia escritas, sem downtime, sem locks longos.
- Mais pesado dela é o ADD INDEX em `ai_agents` (1 tabela com poucas rows em prod — trivial).
- Recreate de FK é metadado-only (sem rescan de rows).
- Rename de índices é metadado-only.

## Validação

### 1. `prisma migrate diff` autoritativo pós-fix
```
-- This is an empty migration.
```
**Zero drift remanescente.** Output limpo.

### 2. `prisma migrate deploy` em DB virgem (from scratch)
```
35 migrations found in prisma/migrations
All migrations have been successfully applied.
```
Todas as 35 migrations (34 + a nova) rodam em sequência sem erro.

### 3. Validação por catálogo Postgres pós-deploy
- `NotificationType`: 8 valores incluindo `AI_TOOL_FAILURE` ✅
- `channels.ai_enabled`: `nullable=YES, default=NULL` ✅
- `ai_agents` indexes: `idx_ai_agent_org_dept` ✅, `idx_ai_agent_parent` ✅ (renomeado)
- `organization_credential_audits` indexes: nome canônico Prisma ✅

### 4. `prisma migrate status` final
```
Database schema is up to date!
```

## Impacto em prod (estimado)

- **NotificationType.AI_TOOL_FAILURE**: corretivo crítico. Qualquer evento de falha de tool de AI agent que tentou criar Notification estava crashando silenciosamente. Após deploy, eventos passam a ser persistidos corretamente.
- **channels.ai_enabled tristate**: sem efeito imediato (todos os channels em prod foram criados com `true`, ficam `true`). Mas onboarding futuro e UI "desligar IA neste canal" passam a funcionar com NULL como esperado.
- **Índices**: idx_ai_agent_org_dept melhora performance de queries Jarvis "filtrar por departamento" (ainda baixa cardinalidade em prod, ganho marginal).
- **FK e renames**: zero impacto funcional, apenas elimina warnings futuros de `prisma migrate diff`.

## Lições e Tech Debt (para próximas sprints)

### TD-W4-001 — Pre-commit hook `prisma migrate diff --exit-code`
Adicionar no `.husky/pre-commit` (ou equivalente) check que bloqueia commit quando há drift schema↔migrations não resolvido. Comando: `npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --exit-code`. Sai não-zero se houver diff.

### TD-W4-002 — CI step "prisma drift check"
Step no GitHub Actions / Coolify CI: rodar `migrate diff` no PR e falhar se output não-vazio. Garante que merge nunca traz drift de novo.

### TD-W4-003 — Pattern Bravy: NUNCA `prisma db push` em projetos com migrate workflow
Documentar em `~/Dev/.cursor/rules/bravy-database.mdc` que `db push` é proibido em projetos que usam `migrate deploy` em prod (todos os Bravy). Quem precisar testar schema rapidamente em dev → `migrate dev --create-only` + `migrate dev`.

### TD-W4-004 — Sweep periódico mensal
Rodar `prisma migrate diff` no início de cada sprint pra detectar drift antes que vire bug em prod. Pode virar parte do CTO bootstrap.

## Próximos passos

1. Push da branch `fix/s18-w4a-migration-drift-sweep` para origin
2. Merge em main após smoke local (`prisma migrate deploy` em DB local)
3. Tag `wave4-pre-deploy` em main (ANTES do merge)
4. Doc redeploya bullq2-api no Coolify → migration aplica via boot hook
5. Validar `prisma migrate status` em prod via Coolify Terminal
6. Smoke E2E pós-deploy: tentar criar 2º agente Jarvis com parent + verificar `channels` tristate ainda intact

## Referências

- Bug do Jarvis (causa raiz original): commit `1d08a75` (`fix/s18-jarvis-missing-migration-org-tree`)
- Merge JP suspeito: `b9db5dd Merge upstream/main from jpasv (2026-05-08 batch)` + iterações posteriores
- Schema atual: `prisma/schema.prisma` (1680 linhas, 35 models, vários enums)
- Total migrations pós-fix: 35
