-- Sprint S18 Wave 4 — Theme Presets Library (Fase 1 backend)
--
-- Transforma o "slot único" de tema custom (Wave 3: organizations.theme_tokens
-- JSONB nullable) em biblioteca de presets nomeados.
--
-- - `theme_presets` armazena N presets nomeados por org
-- - `organizations.active_theme_preset_id` aponta pro preset atualmente ativo
-- - `organizations.theme_tokens` continua sendo o cache do preset ativo (hot
--   path do BrandThemeBridge); backward-compat zero-mudança no frontend
--
-- Idempotente: usa IF NOT EXISTS pra suportar re-execução em caso de
-- rollback parcial.
--
-- IDs cuid() (TEXT) pra alinhar com o padrão do schema Prisma. NÃO usar UUID
-- aqui — o resto do schema é cuid() e qualquer FK iria quebrar.

CREATE TABLE IF NOT EXISTS "theme_presets" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "org_id"     TEXT NOT NULL,
  "name"       VARCHAR(80) NOT NULL,
  "tokens"     JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" TEXT,
  CONSTRAINT "theme_presets_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "theme_presets_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "theme_presets_org_id_name_key"
  ON "theme_presets"("org_id", "name");

CREATE INDEX IF NOT EXISTS "theme_presets_org_id_idx"
  ON "theme_presets"("org_id");

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "active_theme_preset_id" TEXT;

-- FK separada pra ser idempotente (ADD CONSTRAINT IF NOT EXISTS não existe em pg<14
-- de forma portátil; usamos DO block).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_active_theme_preset_id_fkey'
  ) THEN
    ALTER TABLE "organizations"
      ADD CONSTRAINT "organizations_active_theme_preset_id_fkey"
      FOREIGN KEY ("active_theme_preset_id") REFERENCES "theme_presets"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
