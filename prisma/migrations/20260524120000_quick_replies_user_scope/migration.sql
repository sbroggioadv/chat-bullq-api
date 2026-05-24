-- Sprint S21 Wave 1 — Quick Replies user-scope (aditiva, zero-downtime)
--
-- Adiciona userId nullable + FK ON DELETE CASCADE + troca o índice unique.
-- userId NULL = atalho legado org-wide (preservado); preenchido = privado.
-- Postgres trata NULLs como distintos em UNIQUE por padrão — comportamento desejado.

ALTER TABLE "quick_replies"
  ADD COLUMN IF NOT EXISTS "user_id" TEXT;

-- Troca do índice único — drop do antigo (org, shortcut) e criação do novo (org, user, shortcut).
DROP INDEX IF EXISTS "quick_replies_organization_id_shortcut_key";

CREATE UNIQUE INDEX IF NOT EXISTS "quick_replies_organization_id_user_id_shortcut_key"
  ON "quick_replies" ("organization_id", "user_id", "shortcut");

CREATE INDEX IF NOT EXISTS "quick_replies_organization_id_user_id_idx"
  ON "quick_replies" ("organization_id", "user_id");

-- FK pra users.id com CASCADE — atalho some quando o user some.
ALTER TABLE "quick_replies"
  ADD CONSTRAINT "quick_replies_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
