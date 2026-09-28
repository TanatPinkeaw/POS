-- Supervisor PIN and the audit trail.
--
-- The SRS gives staff a role and nothing else; it has no notion of one person
-- authorising another's action, which is what a void, an over-limit discount or
-- a by-hand transfer confirmation actually needs. Nothing here can cite a
-- section of `system_requirements_document.md`.
--
-- As elsewhere in this directory, the constraints Prisma's schema language
-- cannot express are written here by hand and this file is authoritative for
-- them. Apply it with `prisma migrate deploy` and never `migrate dev`, or the
-- hand-written half is dropped.
--
-- Generated with:
--   prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
-- then edited. The diff also proposed `ALTER TABLE "time_logs" DROP COLUMN
-- "work_hours"`, which is *not* included and must never be: `work_hours` is a
-- PostgreSQL STORED generated column that Prisma cannot model (see the note at
-- the top of prisma/schema.prisma), so a mechanical diff reads its absence from
-- the model as a deletion. Dropping it would silently zero every timesheet.

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('void_order', 'over_discount', 'drawer_open', 'manual_payment_confirm', 'pin_set', 'pin_reset', 'pin_locked', 'display_paired', 'display_revoked');

-- AlterTable
ALTER TABLE "users"
    ADD COLUMN "pin_hash" VARCHAR(255),
    ADD COLUMN "pin_failed_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "pin_locked_until" TIMESTAMPTZ(6);

-- A bcrypt digest is always 60 characters. The length floor is here to catch the
-- mistake this column invites: storing the four digits themselves. A CHECK can
-- refuse a short value, which is the difference between a plaintext PIN that is
-- merely stored and one that is stored *and rejected*.
ALTER TABLE "users"
    ADD CONSTRAINT "chk_users_pin_hash_length" CHECK ("pin_hash" IS NULL OR length("pin_hash") >= 50);

ALTER TABLE "users"
    ADD CONSTRAINT "chk_users_pin_failed_attempts" CHECK ("pin_failed_attempts" >= 0);

-- AlterTable
ALTER TABLE "shops" ADD COLUMN "supervisor_discount_limit_thb" DECIMAL(10,2) NOT NULL DEFAULT 50;

ALTER TABLE "shops"
    ADD CONSTRAINT "chk_shops_discount_limit" CHECK ("supervisor_discount_limit_thb" >= 0);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "action" "audit_action" NOT NULL,
    "actor_user_id" UUID,
    "authorized_by_user_id" UUID,
    "target_type" VARCHAR(40),
    "target_id" VARCHAR(60),
    "shift_id" INTEGER,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- A trail that can be edited is not a trail. Rows are append-only, and enforced
-- rather than merely agreed: an UPDATE could rewrite who approved what, a DELETE
-- could remove the evidence of it.
--
-- This raises rather than doing nothing, because a silent no-op would let a
-- future caller believe its update succeeded. It is also why the foreign keys
-- below are ON DELETE RESTRICT rather than SET NULL: nulling a column is an
-- UPDATE, and a trail whose actor can be anonymised is a trail that stops
-- answering the question it exists for. Nothing in the application deletes a
-- user, a drawer or an order, so the restriction costs nothing today.
CREATE FUNCTION audit_logs_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only; % was attempted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_logs_append_only
    BEFORE UPDATE OR DELETE ON "audit_logs"
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_authorized_by_user_id_fkey" FOREIGN KEY ("authorized_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
