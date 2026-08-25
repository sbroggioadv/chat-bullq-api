-- SPEC-009 D1: âncora conversa ↔ task ClickUp.
-- Project.clickup_task_id permanece cruzamento opcional. hoppe_id permanece legado e intocado.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "clickup_task_id" TEXT;
CREATE INDEX IF NOT EXISTS "idx_conv_org_clickup" ON "conversations"("organization_id", "clickup_task_id");
