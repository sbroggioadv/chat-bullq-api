-- Sprint S18 Wave 4 — Compat migration (Fase 5)
--
-- Backfill: pra cada org que tem `organizations.theme_tokens` setado pela
-- Wave 3 (slot único) MAS ainda não tem preset ativo (Wave 4), cria um
-- preset "Tema personalizado" com esses tokens e ativa.
--
-- Idempotente: a UNIQUE(org_id, name) impede duplicação, e o WHERE
-- `active_theme_preset_id IS NULL` garante que rerun não cria segunda
-- cópia depois que o backfill rodou.
--
-- Depende da migration 20260517220000_theme_presets_table.

-- Passo 1: cria preset "Tema personalizado" pra cada org com theme_tokens
--          mas sem active_theme_preset_id. cuid() simulado via concat
--          "preset_" + gen_random_uuid (não usa gen_random_uuid puro pra
--          IDs cuid-shape, mas Postgres não tem cuid nativo — o que importa
--          é ser único e text). Em prod o Prisma cria cuids verdadeiros;
--          aqui só pro backfill um UUID hex serve igual.
INSERT INTO "theme_presets" ("id", "org_id", "name", "tokens", "created_at", "updated_at")
SELECT
  CONCAT('cmpcompat_', REPLACE(gen_random_uuid()::text, '-', '')) AS id,
  o."id" AS org_id,
  'Tema personalizado' AS name,
  o."theme_tokens" AS tokens,
  NOW() AS created_at,
  NOW() AS updated_at
FROM "organizations" o
WHERE o."theme_tokens" IS NOT NULL
  AND o."active_theme_preset_id" IS NULL
ON CONFLICT ("org_id", "name") DO NOTHING;

-- Passo 2: ativa o preset recém-criado nas mesmas orgs.
UPDATE "organizations" o
SET "active_theme_preset_id" = tp."id"
FROM "theme_presets" tp
WHERE tp."org_id" = o."id"
  AND tp."name" = 'Tema personalizado'
  AND o."theme_tokens" IS NOT NULL
  AND o."active_theme_preset_id" IS NULL;
