-- Sprint S18 Wave 3 — Theme Builder OKLCH PRO (Fase 1 backend)
--
-- Adiciona `theme_tokens` JSONB nullable em organizations. NULL = usa só
-- `brand` (A/B/C). Não-null = override com tokens customizados (OKLCH).
--
-- Shape esperado (validado server-side em UpdateOrganizationDto):
-- {
--   "base": "A" | "B" | "C",
--   "light": { "primary", "accent", "success", "warning", "danger" },
--   "dark":  { "primary", "accent", "success", "warning", "danger" },
--   "radius": "0.5rem",
--   "density": "compact" | "comfortable" | "spacious"
-- }
--
-- Idempotente: usa IF NOT EXISTS pra suportar re-execução em caso de
-- rollback parcial. Não tem default — null é o estado válido (usa brand).

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "theme_tokens" JSONB;
