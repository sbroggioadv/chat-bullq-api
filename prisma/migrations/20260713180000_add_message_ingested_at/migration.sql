-- Add a persistence-time cursor independent from the provider timestamp.
-- Existing rows receive the migration time; the id is the deterministic
-- tie-breaker for that initial backfill batch.
ALTER TABLE "messages"
ADD COLUMN "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "idx_msg_ingested_cursor"
ON "messages"("ingested_at", "id");
