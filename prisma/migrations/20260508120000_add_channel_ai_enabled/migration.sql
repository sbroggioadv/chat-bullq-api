-- Migration: add channels.ai_enabled (drift fix from upstream curso jpasv)
--
-- Context: schema.prisma:139 declares `Channel.aiEnabled` but the original
-- `20260502192048_ai_agents_foundation` migration only added `ai_enabled` to
-- `conversations` and `organizations`, missing the column on `channels`.
--
-- bullq2 local DB had been corrected via `prisma db push` (manual sync) to add
-- the column, but no formal migration existed. This migration registers it so
-- Coolify/staging/prod can run `prisma migrate deploy` cleanly without drift.
--
-- IF NOT EXISTS guard: idempotent — safe on environments where `db push`
-- already created the column manually.

ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "ai_enabled" BOOLEAN NOT NULL DEFAULT true;
