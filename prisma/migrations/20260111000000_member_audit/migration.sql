-- ------------------------------------------------------- customer accounts
--
-- Creating a customer at the counter is the first thing in this system that hands
-- out an account to somebody who is not staff, and a member account can reserve
-- stock without paying for it. That is the one capability here worth inventing an
-- identity to obtain, so both halves are worth a trail: the account being made,
-- and anything later changing how it signs in.
--
-- Two values rather than one. `member_created` is an event an owner may be glad of
-- (the shop's customer list growing); `member_updated` is the one they go looking
-- for (a phone number that used to work, an account that was closed). Filtering
-- for one should not have to read through the other.
--
-- A rename is deliberately *not* recorded — see `src/lib/members.ts`. The trail's
-- value is in being narrow.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'member_created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'member_updated';
