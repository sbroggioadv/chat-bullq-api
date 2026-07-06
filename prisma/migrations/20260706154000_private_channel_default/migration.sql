-- New channels are private by default. Existing channels keep their current
-- visibility so this is not a breaking access change for production users.

ALTER TABLE "channels"
  ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';
