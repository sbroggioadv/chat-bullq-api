-- Executar somente com autorização e backup: remove o estado de silêncio.
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "muted_until";
