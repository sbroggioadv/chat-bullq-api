-- S18/W1B v2 — Fix migration v1 false positives + restore legitimate names
--
-- Bug discovered in v1 (20260515120000_contact_name_drift_cleanup) during
-- S18 Wave 1 local validation: the phone exception (`phone !~ '5517996180093'`)
-- did NOT normalize formatting before comparison. Production phone column
-- stores values formatted like `+55 17 99618-0093`, so the literal regex
-- never matched the operator's number. Result: ALL operator self-contacts
-- (Doc messaging himself, his own number across orgs) had `name` reset to
-- NULL when they should have been preserved.
--
-- Additionally, the v1 regex `^\s*sbroggio\s+(advogado|adv)\s*$` correctly
-- matched legitimate office contacts like "SBROGGIO ADV" — but those entries
-- ARE the office's own identity, not drift contamination. They should not
-- be cleared either.
--
-- This v2 migration:
--   1. Restores `contact.name` from `metadata.nameDriftCleanup.previousName`
--      for rows where:
--      - Normalized phone equals the operator's number (Doc self-contacts), OR
--      - The previous name was an office-identity label ("SBROGGIO ADV" /
--        variants) — those are legitimate, not drift.
--   2. Stamps `metadata.nameDriftCleanup.restoredAt` + `metadata.nameDriftCleanup.restoredReason`
--      so we keep the audit trail (we know the row was cleared AND then restored)
--      and so re-running this migration is a no-op.
--
-- Idempotent: only acts on rows with `nameDriftCleanup` stamp but no `restoredAt`.

UPDATE contacts
SET
  name = metadata->'nameDriftCleanup'->>'previousName',
  metadata = jsonb_set(
    metadata,
    '{nameDriftCleanup,restoredAt}',
    to_jsonb(NOW())
  ) || jsonb_build_object(
    'nameDriftCleanup',
    (metadata->'nameDriftCleanup') ||
    jsonb_build_object(
      'restoredAt', NOW(),
      'restoredReason',
      CASE
        WHEN REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') = '5517996180093'
          THEN 'operator-self-contact: normalized phone matches owner'
        WHEN (metadata->'nameDriftCleanup'->>'previousName') ~* '^\s*sbroggio\s+(advogado|adv)\s*$'
          THEN 'office-identity: previous name is the firm''s own label'
        ELSE 'unexpected: row matched outer WHERE but no restore reason'
      END
    )
  )
WHERE
  -- Only act on rows previously cleared by v1.
  (metadata->'nameDriftCleanup') IS NOT NULL
  -- Skip rows we've already restored (idempotent).
  AND (metadata->'nameDriftCleanup'->'restoredAt') IS NULL
  -- Only restore rows that match the (corrected) exceptions:
  AND (
    -- Doc's self-contact (normalized phone match — works regardless of formatting)
    REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') = '5517996180093'
    OR
    -- Office-identity labels (the previousName itself is legitimate)
    (metadata->'nameDriftCleanup'->>'previousName') ~* '^\s*sbroggio\s+(advogado|adv)\s*$'
  )
  AND deleted_at IS NULL;
