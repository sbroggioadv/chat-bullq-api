-- Providers Kimi (Moonshot) + z.ai (Zhipu/GLM)
--
-- Additive-only: adiciona os valores KIMI e ZAI ao enum "AiProvider".
--
-- Segurança/zero-downtime:
--   - ALTER TYPE ... ADD VALUE é aditivo: não reescreve linhas, não bloqueia
--     leituras/escritas concorrentes das linhas existentes.
--   - IF NOT EXISTS torna a migration idempotente em re-run.
--   - PG 12+ permite ADD VALUE dentro de uma transação desde que o novo valor
--     NÃO seja usado na mesma transação — aqui só declaramos os valores, sem
--     usá-los, então roda limpo no wrap transacional do `migrate deploy`.
--
-- NÃO aplicada em produção por este commit (só o arquivo é gerado). O deploy
-- da migration é passo de config separado (CONFIRMO do operador).
ALTER TYPE "AiProvider" ADD VALUE IF NOT EXISTS 'KIMI';
ALTER TYPE "AiProvider" ADD VALUE IF NOT EXISTS 'ZAI';
