-- SPEC-006: documentos de conhecimento por agente
CREATE TABLE IF NOT EXISTS "ai_agent_knowledge_docs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "storage_path" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "error_message" TEXT,
  "chunk_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "ai_agent_knowledge_docs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_ai_agent_knowledge_agent"
  ON "ai_agent_knowledge_docs"("agent_id");
CREATE INDEX IF NOT EXISTS "idx_ai_agent_knowledge_org"
  ON "ai_agent_knowledge_docs"("organization_id");

ALTER TABLE "ai_agent_knowledge_docs"
  ADD CONSTRAINT "ai_agent_knowledge_docs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_knowledge_docs"
  ADD CONSTRAINT "ai_agent_knowledge_docs_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
