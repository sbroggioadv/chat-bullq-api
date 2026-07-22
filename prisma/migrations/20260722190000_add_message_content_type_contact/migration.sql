-- SPEC-003 W3 / S21 W3: MessageContentType.CONTACT for shared vCards.
-- Isolated ADD VALUE — safe zero-downtime on Postgres 12+.
ALTER TYPE "MessageContentType" ADD VALUE IF NOT EXISTS 'CONTACT';
