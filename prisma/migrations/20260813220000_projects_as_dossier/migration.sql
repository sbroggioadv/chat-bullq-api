-- SPEC-005: projeto deixa de ser 1:1 com grupo.
ALTER TABLE "projects" ALTER COLUMN "group_jid" DROP NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'TODO';

DROP INDEX IF EXISTS "uq_project_org_jid";
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_org_jid"
  ON "projects" ("organization_id", "group_jid")
  WHERE "group_jid" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "project_tasks" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "done" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_project_task_order" ON "project_tasks"("project_id", "sort_order");
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "project_attachments" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "message_id" TEXT,
  "conversation_id" TEXT,
  "label" TEXT NOT NULL,
  "file_name" TEXT,
  "mime_type" TEXT,
  "url" TEXT,
  "preview" TEXT,
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_attachments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_project_attachment_project" ON "project_attachments"("project_id");
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "project_contacts" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_contacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_contact" ON "project_contacts"("project_id", "contact_id");
ALTER TABLE "project_contacts" ADD CONSTRAINT "project_contacts_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_contacts" ADD CONSTRAINT "project_contacts_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "project_conversations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_conversations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_conversation" ON "project_conversations"("project_id", "conversation_id");
ALTER TABLE "project_conversations" ADD CONSTRAINT "project_conversations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_conversations" ADD CONSTRAINT "project_conversations_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
