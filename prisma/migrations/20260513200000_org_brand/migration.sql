-- Sprint S17 · Theme System · org-level brand identity
-- Adds Organization.brand (nullable TEXT). null = no choice yet — OWNER sees the
-- onboarding wizard on next entry. Allowed values: 'A' | 'B' | 'C' (validated at
-- the DTO layer, not in DB, to keep migrations cheap).
-- Idempotent: safe to re-run on environments where the column already exists.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "brand" TEXT;
