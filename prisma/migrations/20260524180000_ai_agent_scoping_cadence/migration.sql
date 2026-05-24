-- Sprint S22 — AI Agent Scoping & Cadence (aditiva, zero-downtime)

-- AiAgent: 6 novos campos com defaults
ALTER TABLE "ai_agents"
  ADD COLUMN IF NOT EXISTS "pipeline_scope"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "mention_handle"        TEXT,
  ADD COLUMN IF NOT EXISTS "rate_limit_per_hour"   INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "consecutive_msg_cap"   INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "humanization_enabled"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "min_delay_ms"          INTEGER NOT NULL DEFAULT 15000;

-- Unique de mentionHandle por org (NULLs distintos no Postgres por padrão)
CREATE UNIQUE INDEX IF NOT EXISTS "ai_agents_organization_id_mention_handle_key"
  ON "ai_agents" ("organization_id", "mention_handle");

-- Conversation: 1 novo campo (default false — whitelist explícita)
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "ai_allowed_in_group" BOOLEAN NOT NULL DEFAULT false;

-- AiResponseLog: tabela nova
CREATE TABLE IF NOT EXISTS "ai_response_logs" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "organization_id"  TEXT NOT NULL,
  "agent_id"         TEXT NOT NULL,
  "channel_id"       TEXT NOT NULL,
  "conversation_id"  TEXT NOT NULL,
  "message_id"       TEXT,
  "sent_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes pras queries de cap (rolling window) + dashboard
CREATE INDEX IF NOT EXISTS "ai_response_logs_channel_id_sent_at_idx"
  ON "ai_response_logs" ("channel_id", "sent_at" DESC);
CREATE INDEX IF NOT EXISTS "ai_response_logs_conversation_id_sent_at_idx"
  ON "ai_response_logs" ("conversation_id", "sent_at" DESC);
CREATE INDEX IF NOT EXISTS "ai_response_logs_organization_id_sent_at_idx"
  ON "ai_response_logs" ("organization_id", "sent_at" DESC);

-- FKs com CASCADE
ALTER TABLE "ai_response_logs"
  ADD CONSTRAINT "ai_response_logs_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ai_response_logs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: grupos que já têm IA habilitada (aiEnabled != false) preservam
-- comportamento (continuam falando). Operador desabilita manualmente os
-- grupos problemáticos depois.
UPDATE "conversations"
SET "ai_allowed_in_group" = true
WHERE "is_group" = true
  AND ("ai_enabled" IS NULL OR "ai_enabled" = true);
