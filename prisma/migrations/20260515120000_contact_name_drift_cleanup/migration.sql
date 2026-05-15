-- S18/W1B — Contact name drift cleanup
--
-- Historical bug: the Zappfy adapter used `event.chat.name` as the contact
-- name even for `fromMe=true` (echo) events. That value comes from the
-- CONNECTED WhatsApp's address book, i.e. the operator's local label for
-- the contact. The Doc's phone has the same label ("Luis Sbroggio" and
-- variants) applied to MANY clients — so a flurry of those clients had
-- their `contact.name` overwritten to the operator's name on the first
-- echo event after they were created.
--
-- This migration:
--   1. Resets contact.name to NULL for any contact whose name matches an
--      operator-label pattern AND whose phone is NOT the owner's phone.
--      The phone gate is critical — we don't want to nuke the legitimate
--      self-contact entry (the Doc messaging himself in tests).
--   2. Records `metadata.nameDriftCleanup` with a timestamp so we can
--      audit later and so a re-run is idempotent.
--
-- Effect: the next authoritative inbound (`contactNameIsAuthoritative=true`)
-- from each affected contact will refill `name` correctly. Contacts that
-- the operator already manually renamed are protected by the new
-- `metadata.nameLockedByUser` flag set by S18/W1B on PATCH /contacts/:id —
-- BUT pre-S18 renames were not tracked, so we exclude any contact whose
-- `updatedAt` is significantly more recent than `createdAt`, treating
-- those as likely-user-edited and leaving them alone.

UPDATE contacts
SET
  name = NULL,
  metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{nameDriftCleanup}',
    to_jsonb(jsonb_build_object(
      'clearedAt', NOW(),
      'previousName', name
    ))
  )
WHERE
  -- Operator-label patterns. Doc's name appears with several variants
  -- in the wild — the regex is conservative to avoid false positives on
  -- legitimate clients also called Luis.
  (
    name ~* '^\s*(dr\.?|doutor)?\s*(luis|luiz)\s+(augusto\s+)?(sbroggio|lacanna)\s*'
    OR name ~* '^\s*sbroggio\s+(advogado|adv)\s*$'
  )
  -- Don't touch the legitimate self-contact (Doc messaging himself).
  AND (phone IS NULL OR phone !~ '5517996180093')
  -- Don't touch contacts whose name was likely manually edited post-creation.
  -- 5 minutes is a generous threshold: pipeline writes that happen on the
  -- inbound path complete within seconds.
  AND updated_at <= created_at + INTERVAL '5 minutes'
  -- Don't re-run on rows already cleared.
  AND (metadata->'nameDriftCleanup') IS NULL
  AND deleted_at IS NULL;
