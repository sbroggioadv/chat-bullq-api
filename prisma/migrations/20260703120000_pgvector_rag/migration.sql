-- ============================================================================
-- RAG vector store — pgvector + ai_vector_entries
-- ============================================================================
-- Contexto:
-- - O codigo RAG usa SQL cru via Prisma porque Prisma nao modela vector(1536).
-- - Esta migration versiona a tabela que antes existia apenas como comentario
--   em VectorStoreService.
-- - Em Supabase, rode migrations pela conexao direta/session, nao pelo pooler
--   transaction-mode.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "ai_vector_entries" (
  "id"              TEXT NOT NULL,
  "owner_type"      TEXT NOT NULL,
  "owner_id"        TEXT NOT NULL,
  "conversation_id" TEXT,
  "agent_id"        TEXT,
  "contact_id"      TEXT,
  "content"         TEXT NOT NULL,
  "embedding"       vector(1536) NOT NULL,
  "metadata"        JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ai_vector_entries_pkey" PRIMARY KEY ("id")
);

-- Defense in depth for Supabase public schema. Backend Prisma connections
-- should use the table owner/migration role or receive an explicit backend
-- policy before switching to a non-owner runtime role.
ALTER TABLE "ai_vector_entries" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "ai_vector_entries" FROM anon;
REVOKE ALL ON TABLE "ai_vector_entries" FROM authenticated;

CREATE INDEX IF NOT EXISTS "ai_vector_entries_owner_idx"
  ON "ai_vector_entries"("owner_type", "owner_id");

CREATE INDEX IF NOT EXISTS "ai_vector_entries_conversation_idx"
  ON "ai_vector_entries"("conversation_id");

CREATE INDEX IF NOT EXISTS "ai_vector_entries_agent_idx"
  ON "ai_vector_entries"("agent_id");

CREATE INDEX IF NOT EXISTS "ai_vector_entries_contact_idx"
  ON "ai_vector_entries"("contact_id");

-- Approximate nearest-neighbour index for cosine distance.
-- lists=100 is appropriate for tens of thousands of rows; tune for >1M rows.
CREATE INDEX IF NOT EXISTS "ai_vector_entries_embedding_idx"
  ON "ai_vector_entries"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);

ANALYZE "ai_vector_entries";
