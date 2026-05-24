-- S22.2 — AI Panic Mode (kill switch absoluto, aditiva, zero-downtime)
--
-- Default false → comportamento atual preservado. Operador liga via PATCH
-- /organizations/:id { aiPanicMode: true } pra calar TUDO (scope, conv
-- override, channel override) — gate é a primeira coisa em shouldHandle.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "ai_panic_mode" BOOLEAN NOT NULL DEFAULT false;
