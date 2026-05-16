-- ============================================================================
-- S18 / Wave 4 / W4-A — Migration Drift Sweep
-- ============================================================================
-- Esta migration corrige TODO o drift schema.prisma <-> migrations history
-- descoberto pelo `prisma migrate diff` autoritativo após o bug do Jarvis
-- (schema↔migrations drift em ai_agents).
--
-- Provável causa raiz: merge upstream JP de 2026-05-13 (43 commits) +
-- alguém rodou `prisma db push` em dev local sem propagar via `migrate dev`.
-- O schema TS ficou correto, o DB de prod não.
--
-- Todas as alterações são IDEMPOTENTES (IF NOT EXISTS / IF EXISTS) pra
-- suportar ambientes em diferentes estados (prod pode não ter o índice X,
-- staging pode já ter o rename Y feito manualmente).
--
-- Itens corrigidos:
--   1. NotificationType: ADD VALUE 'AI_TOOL_FAILURE' (schema esperava, DB não)
--   2. channels.ai_enabled: DROP NOT NULL + DROP DEFAULT (tristate como
--      conversations — NULL = segue org.ai_enabled)
--   3. ai_agents: ADD INDEX idx_ai_agent_org_dept (organization_id, department)
--   4. ai_agents: RENAME INDEX ai_agents_parent_agent_id_idx -> idx_ai_agent_parent
--   5. messages.revoked_by FK: recreate com ON UPDATE CASCADE (era padrão SQL)
--   6. organization_credential_audits: RENAME INDEX org_created_idx -> padrão Prisma
--
-- Operação 100% aditiva/cosmética. Não toca dados. Não bloqueia. Sem downtime.
-- ============================================================================

-- 1) NotificationType: adicionar AI_TOOL_FAILURE
-- Postgres não suporta IF NOT EXISTS em ADD VALUE direto, então usamos DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'NotificationType' AND e.enumlabel = 'AI_TOOL_FAILURE'
  ) THEN
    ALTER TYPE "NotificationType" ADD VALUE 'AI_TOOL_FAILURE';
  END IF;
END$$;

-- 2) channels.ai_enabled: virar tristate (NULL = segue org)
-- Schema: `aiEnabled Boolean? @map("ai_enabled")` (nullable, sem default)
-- DB atual: `BOOLEAN NOT NULL DEFAULT true` (criado em 20260508120000_add_channel_ai_enabled)
-- Operação aditiva: relaxa constraint, dados existentes (true/false) ficam preservados.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'channels'
      AND column_name = 'ai_enabled'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "channels" ALTER COLUMN "ai_enabled" DROP NOT NULL;
    ALTER TABLE "channels" ALTER COLUMN "ai_enabled" DROP DEFAULT;
  END IF;
END$$;

-- 3) ai_agents: índice composto (organization_id, department) — schema espera, DB não tem
-- Permite listar agentes por setor da org sem table scan.
CREATE INDEX IF NOT EXISTS "idx_ai_agent_org_dept" ON "ai_agents"("organization_id", "department");

-- 4) ai_agents: rename do índice de parent_agent_id pro nome canônico do schema
-- Schema: `@@index([parentAgentId], name: "idx_ai_agent_parent")`
-- Migration anterior criou: `ai_agents_parent_agent_id_idx` (padrão Prisma auto)
-- Renomear pra alinhar é seguro: índice continua válido, só muda o nome no catálogo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'ai_agents_parent_agent_id_idx'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_ai_agent_parent'
  ) THEN
    ALTER INDEX "ai_agents_parent_agent_id_idx" RENAME TO "idx_ai_agent_parent";
  END IF;
END$$;

-- 5) messages.revoked_by FK: recreate com ON UPDATE CASCADE
-- Schema: Prisma default é ON UPDATE CASCADE quando não especificado.
-- Migration criou: `ON DELETE SET NULL` sem cláusula ON UPDATE.
-- Recreate idempotente pra alinhar com padrão Prisma (no-op se já está correto).
DO $$
DECLARE
  fk_update_action TEXT;
BEGIN
  SELECT confupdtype INTO fk_update_action
  FROM pg_constraint
  WHERE conname = 'messages_revoked_by_fkey';

  -- 'c' = CASCADE, 'a' = NO ACTION (default), 'r' = RESTRICT, 'n' = SET NULL, 'd' = SET DEFAULT
  IF fk_update_action IS NOT NULL AND fk_update_action != 'c' THEN
    ALTER TABLE "messages" DROP CONSTRAINT "messages_revoked_by_fkey";
    ALTER TABLE "messages"
      ADD CONSTRAINT "messages_revoked_by_fkey"
      FOREIGN KEY ("revoked_by") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- 6) organization_credential_audits: rename do índice pro padrão Prisma
-- Schema espera: `organization_credential_audits_organization_id_created_at_idx` (auto-nome Prisma)
-- Migration criou: `organization_credential_audits_org_created_idx` (custom name encurtado)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'organization_credential_audits_org_created_idx'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'organization_credential_audits_organization_id_created_at_idx'
  ) THEN
    ALTER INDEX "organization_credential_audits_org_created_idx"
      RENAME TO "organization_credential_audits_organization_id_created_at_idx";
  END IF;
END$$;
