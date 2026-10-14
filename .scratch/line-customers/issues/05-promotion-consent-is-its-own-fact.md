# 05: Promotion consent is its own fact, and "no" is a state

**What to build:** A customer can agree to hear about promotions — and withdraw that
without losing their order notifications — as a decision of its own, recorded on their
row, offered on the LINE card in both surfaces.

**Blocked by:** None.
**Status:** done

- [ ] Schema + migration on `users`: `line_promo_consent_at` (nullable timestamptz),
      `line_promo_withdrawn_at` (nullable timestamptz), `line_promo_consent_version`
      (nullable varchar). No boolean, and the reason is on the column: a boolean cannot
      say **"never asked"** and **"said no"** apart, and those two need different
      sentences on the customer's screen — one offers the choice, the other must not
      offer it again.
- [ ] `src/lib/line-promo-consent.ts` — **pure**: `linePromoConsentState({consentAt,
      withdrawnAt, version})` returns `'never_asked' | 'consented' | 'withdrawn'` with
      the **later timestamp winning**, and `linePromoConsentBlock(...)` names the reason
      a campaign cannot reach this customer (`never_asked`, `withdrawn`, `not_bound`,
      `not_a_friend`) in the shape `lineCustomerNotifyBlock` already established —
      one closed set of reasons, one Thai sentence each.
- [ ] Writing it lives in `line-identity.ts`, beside the consent it is next to and the
      binding it depends on: `setLinePromotionConsent({userId, consent: true|false,
      version})`, audited as `member_updated` with the field named and the version, the
      same shape `setLineNotificationConsent` uses. Withdrawal is an act, not a deletion:
      the timestamp is what records it.
- [ ] **Withdrawing promotion never touches the binding or the notification consent** —
      that separation is the whole point of this ticket. Unbinding (`unbindLineFromCustomer`)
      keeps clearing everything, because it removes the address itself.
- [ ] The LINE card (`LinePanel` in `AccountPortal.tsx`) gains the promotion consent as
      its own control with its own wording and its own version, and so does the LIFF
      claim/signed-in surface where the customer is already reading about their account.
      The wording is versioned like the privacy notice, and the version acknowledged
      rides the audit row.
- [ ] It is **never bundled into binding**: a customer who binds their LINE does not
      thereby agree to promotions, and a test pins that (a fresh binding leaves
      `line_promo_consent_at` null).
- [ ] Tests: the pure state for all five combinations (including withdrawn-then-consented
      again, which is `consented`), and against real Postgres — withdraw then consent
      again is one row with both timestamps and the state `consented`; unbinding clears
      all four LINE columns.

## Notes

**Why a second consent rather than reusing `line_consent_at`.** That timestamp means
"tell me about my own order" — a message the customer asked for by placing the order.
A promotion is a different purpose, and PDPA-style honesty requires the shop to be able
to say who agreed to what and when. Reusing one timestamp would make the existing
sentence on the account page quietly mean something broader than the customer agreed to.
