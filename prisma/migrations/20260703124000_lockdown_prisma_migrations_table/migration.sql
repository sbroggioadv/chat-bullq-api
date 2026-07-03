-- ============================================================================
-- Lock down Prisma migration history in Supabase public schema
-- ============================================================================
-- Prisma owns and writes this table through the migration/runtime database role.
-- Supabase Data API roles should not have direct access to migration history.
-- ============================================================================

ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE "_prisma_migrations" FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE "_prisma_migrations" FROM authenticated;
  END IF;
END $$;
