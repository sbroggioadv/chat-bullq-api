-- Providers Sakana Fugu + Alibaba Qwen (DashScope)
-- Additive-only: ADD VALUE no enum "AiProvider".
-- PG 12+: ADD VALUE na mesma transação é ok se o valor NÃO for usado aqui.
ALTER TYPE "AiProvider" ADD VALUE IF NOT EXISTS 'FUGU';
ALTER TYPE "AiProvider" ADD VALUE IF NOT EXISTS 'QWEN';
