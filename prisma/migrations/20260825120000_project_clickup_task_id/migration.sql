-- SPEC-008 D1: âncora dossiê ↔ task ClickUp. hoppe_id permanece legado e intocado.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "clickup_task_id" TEXT;
CREATE INDEX IF NOT EXISTS "idx_project_org_clickup" ON "projects"("organization_id", "clickup_task_id");
