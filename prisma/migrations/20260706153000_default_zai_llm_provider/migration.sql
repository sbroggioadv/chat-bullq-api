-- Promote Z.AI/GLM as the default LLM provider for organization agents.
-- Existing transcription and embeddings routing stay on OPENAI.

UPDATE "organization_capability_routing"
SET
  "provider_selected" = 'ZAI',
  "model_override" = 'glm-5.2',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "capability" = 'LLM_AGENT'
  AND "provider_selected" = 'ANTHROPIC';

INSERT INTO "organization_capability_routing"
  ("organization_id", "capability", "provider_selected", "model_override", "updated_at")
SELECT "id", 'LLM_AGENT', 'ZAI', 'glm-5.2', CURRENT_TIMESTAMP
FROM "organizations"
ON CONFLICT ("organization_id", "capability") DO NOTHING;

UPDATE "ai_agents"
SET
  "model_id" = 'zai/glm-5.2',
  "model_params" = NULL
WHERE "model_id" LIKE 'anthropic/%'
   OR "model_id" LIKE 'claude-%';
