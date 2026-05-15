-- Sprint S18 · Wave 2 · AI provider credentials per-organization
--
-- Cria 3 enums + 3 tabelas pra permitir que cada org tenha suas próprias keys
-- Anthropic / OpenAI / Gemini, com capability routing (LLM / Transcription /
-- Embeddings → escolha de provider) e audit log append-only.
--
-- Zero-downtime: só CREATE TABLE / CREATE TYPE. Nenhum ALTER em tabelas
-- existentes. Tudo `IF NOT EXISTS` pra ser idempotente em re-run.

-- ─── Enums ──────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "AiProvider" AS ENUM ('ANTHROPIC', 'OPENAI', 'GEMINI');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AiCapability" AS ENUM ('LLM_AGENT', 'TRANSCRIPTION', 'EMBEDDINGS');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CredentialTestStatus" AS ENUM ('UNTESTED', 'SUCCESS', 'FAILURE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CredentialAuditAction" AS ENUM (
    'CREATED', 'UPDATED', 'DELETED',
    'TESTED_SUCCESS', 'TESTED_FAILURE',
    'ROUTING_CHANGED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── organization_credentials ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "organization_credentials" (
  "id"                TEXT NOT NULL,
  "organization_id"   TEXT NOT NULL,
  "provider"          "AiProvider" NOT NULL,
  "encrypted_key"     TEXT NOT NULL,
  "key_hint"          TEXT NOT NULL,
  "last_test_at"      TIMESTAMP(3),
  "last_test_status"  "CredentialTestStatus" NOT NULL DEFAULT 'UNTESTED',
  "last_test_error"   TEXT,
  "created_by_id"     TEXT NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "organization_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "organization_credentials_organization_id_provider_key"
  ON "organization_credentials"("organization_id", "provider");

CREATE INDEX IF NOT EXISTS "organization_credentials_organization_id_idx"
  ON "organization_credentials"("organization_id");

DO $$ BEGIN
  ALTER TABLE "organization_credentials"
    ADD CONSTRAINT "organization_credentials_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "organization_credentials"
    ADD CONSTRAINT "organization_credentials_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── organization_capability_routing ───────────────────────────────
CREATE TABLE IF NOT EXISTS "organization_capability_routing" (
  "organization_id"    TEXT NOT NULL,
  "capability"         "AiCapability" NOT NULL,
  "provider_selected"  "AiProvider" NOT NULL,
  "model_override"     TEXT,
  "updated_at"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "organization_capability_routing_pkey"
    PRIMARY KEY ("organization_id", "capability")
);

DO $$ BEGIN
  ALTER TABLE "organization_capability_routing"
    ADD CONSTRAINT "organization_capability_routing_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed defaults pra todas as orgs existentes (idempotente via ON CONFLICT).
-- LLM_AGENT → ANTHROPIC, TRANSCRIPTION → OPENAI (Whisper), EMBEDDINGS → OPENAI.
INSERT INTO "organization_capability_routing"
  ("organization_id", "capability", "provider_selected", "updated_at")
SELECT "id", 'LLM_AGENT', 'ANTHROPIC', CURRENT_TIMESTAMP FROM "organizations"
ON CONFLICT ("organization_id", "capability") DO NOTHING;

INSERT INTO "organization_capability_routing"
  ("organization_id", "capability", "provider_selected", "updated_at")
SELECT "id", 'TRANSCRIPTION', 'OPENAI', CURRENT_TIMESTAMP FROM "organizations"
ON CONFLICT ("organization_id", "capability") DO NOTHING;

INSERT INTO "organization_capability_routing"
  ("organization_id", "capability", "provider_selected", "updated_at")
SELECT "id", 'EMBEDDINGS', 'OPENAI', CURRENT_TIMESTAMP FROM "organizations"
ON CONFLICT ("organization_id", "capability") DO NOTHING;

-- ─── organization_credential_audits ────────────────────────────────
CREATE TABLE IF NOT EXISTS "organization_credential_audits" (
  "id"               TEXT NOT NULL,
  "organization_id"  TEXT NOT NULL,
  "actor_user_id"    TEXT,
  "action"           "CredentialAuditAction" NOT NULL,
  "provider"         "AiProvider",
  "detail"           TEXT,
  "ip"               TEXT,
  "user_agent"       TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_credential_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "organization_credential_audits_org_created_idx"
  ON "organization_credential_audits"("organization_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "organization_credential_audits"
    ADD CONSTRAINT "organization_credential_audits_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "organization_credential_audits"
    ADD CONSTRAINT "organization_credential_audits_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
