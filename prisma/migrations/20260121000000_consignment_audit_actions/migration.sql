-- ------------------------------------------------- consignment on the trail
--
-- Putting a product into consignment is a shop saying "these goods belong to
-- somebody else, and we owe them this share" — a liability, and the kind of
-- decision that is disputed months later when nobody remembers the percentage.
-- Two values, for the same reason `member_created` and `member_updated` are two:
-- the agreement being set is routine and worth finding, and the goods being taken
-- back is the event an owner goes looking for. Filtering for one should not have
-- to read through the other.
--
-- The detail column carries the consignor, the percent, and the previous values,
-- because a share is renegotiated far more often than it is first set — see
-- `src/lib/consignment.ts`.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'consignment_set';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'consignment_withdrawn';
