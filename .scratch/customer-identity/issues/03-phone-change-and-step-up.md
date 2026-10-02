# 03: Changing a phone proves the new number

**What to build:** A customer can change their phone, and the change is confirmed by an OTP on
the new number before it takes effect.

**Blocked by:** 01.
**Status:** done

- [x] Changing a phone requires a fresh OTP on the **new** number; without it the change is
      refused.
- [x] A new number already owned by another identity is refused, as enrolment already refuses
      a taken number.
- [x] The change is audited (a phone is the identity, so this is a security event).
- [x] Signing in does **not** require an OTP — only signup and phone changes do.
- [x] Tests: a change with no OTP is refused; with a wrong OTP is refused; with the right one
      takes effect and is audited; the refusal names the reason in Thai.

## Notes

OTP-once means a reassigned number can later be captured (ADR 0020, known gaps); re-proving on
every change is the mitigation this ticket implements.

## Continuation checkpoint

**One addition to the rule, in the module that already owns "the phone is the identity".**
`changeCustomerPhone` lives in `src/lib/identity.ts`, and its order is the same shape as
`completeCustomerGoogleSignIn`:

1. **Normalise and load** the row (by the *signed-in* id — the body never names the identity
   being moved), refuse a non-customer account (`NOT_A_MEMBER_ACCOUNT`), and treat a number
   equal to the row's own as a **no-op**: nothing to prove, nothing written, no audit row.
2. **Prove the new number** by consuming the challenge keyed by *it* — so a code minted for the
   old number cannot move an identity onto one its owner does not hold, and nothing is written
   until the code matches. A wrong or expired code is the Thai `VALIDATION_ERROR`.
3. **Refuse a number another identity holds** (`DUPLICATE_ACCOUNT`, Thai message naming the
   reason), with the unique index on `users.phone` as the backstop under the read a race could
   slip between — the same two-read-then-catch shape as the signup rule.
4. **Write and audit**: `member_updated` with `{ fields: ['phone'], previousPhone }`, the shape
   `updateMember` already emits, so the trail reads the same whoever moved the number.

`PATCH /api/v1/auth/phone` (`src/app/api/v1/auth/phone/route.ts`) is the door: it loads the live
row with `requireActiveUser` — a deactivated account must not move a number — reads
`customerPhoneChangeSchema` (`{ phone, code }`), runs the rule, and then **re-issues the
session** because the cookie names the phone and a token carrying the old number would disagree
with the row it describes. There is deliberately **no new rate-limit policy**: the send door is
already limited per number and per address, and the attempt ceiling on the challenge bounds code
guessing.

**Tests.** `tests/customer-phone-change.test.ts` (10) pins: the move takes effect and is audited
with the previous number; a dashed new number finds the challenge; a missing and a wrong code
are refused with the row untouched and no audit row; a code issued for the *old* number cannot
move to a new one; another customer's number and a staff number are both refused; a staff
account cannot be moved through the rule; and changing to the row's own number spends no code.
Against real HTTP and a database, `scripts/acceptance.ts` section 17 (8 checks) starts from the
number the counter enrolled, refuses an unproved change (422), sends a code to the new number
and moves onto it with the points and session intact, signs in afresh on the new number with the
counter password, finds the audit row naming the previous number, and refuses a staff number
(409). Acceptance is **174 checks** (was 166); `npm test` is **1015 tests across 69 files**;
`npm run verify:all` passes all five gates in 3m34s.

**One honesty note.** As with tickets 02 and 05, the rule and its door are built and exercised,
but there is **no customer-facing screen** yet: the phone-change form is part of the portal
(ticket 07), which already lists it. Until then the API is the only way to move a number.

Source: ../spec.md and ../../../docs/adr/0020-a-customer-signs-in-with-google.md.
