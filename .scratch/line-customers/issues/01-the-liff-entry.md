# 01: A customer opens the shop inside LINE, and is already signed in

**What to build:** The shop gets an address a customer can open from inside LINE that
turns the LINE account they are already holding into a session — no redirect walk, no
typed password. `/line` is that address and it is the LIFF app's endpoint URL.

**Blocked by:** None.
**Status:** done

- [ ] `@line/liff` added to `dependencies` and **bundled** (same-origin script: no CSP
      change, and the page keeps working the way every other page here does). It is the
      one dependency this repository takes on for a feature rather than writing itself,
      and the reason is named in the ADR: LIFF's handshake is LINE's own, not a wire
      format this project can speak by hand.
- [ ] `LINE_LIFF_ID` in `.env.example`, unwritten by default. Unset means `/line` is a
      door that is not a door: it says so in Thai and offers `/login`, the way
      `lineCustomerNotifyBlock` and the webhook already treat "unconfigured".
- [ ] `src/lib/line-liff-entry.ts` — **pure**: given (configured, `liffId`, is the
      browser inside LINE, an outcome/error code) it decides one of
      `'unconfigured' | 'open_in_line' | 'sign_in' | 'claim' | 'signed_in' | 'failed'`,
      with the Thai sentence for each. No `liff` import, no `window`, so the decision is
      unit-tested without a browser — the same split as `line-door.ts`.
- [ ] `src/app/line/page.tsx` (server, `dynamic = 'force-dynamic'`) renders the entry
      and, when unconfigured or outside LINE, says so; `src/components/shop/LiffEntry.tsx`
      (client) initialises the SDK, takes `liff.getIDToken()`, and posts it to the
      **existing** `POST /api/v1/auth/line`:
      - a session comes back → go to `redirectTo` (`/shop/products`, `homePathForRole('member')`);
      - `needsPhone: true` → render the claim step **in the page** (phone, OTP code,
        name, notice acknowledgement) and post to the **existing**
        `POST /api/v1/auth/line/link` with the same `idToken`. Nothing new is written on
        the server for this: the route already accepts an id token from the in-app
        surface, which is the decision ADR 0030 §6 made and nothing had used yet.
- [ ] The id token is obtained once per render and **not persisted** in storage: it is
      a credential, and the session cookie is what the rest of the app uses.
- [ ] `/line` is public in `src/lib/roles.ts` (`isPublicPath`), is added to
      `ROUTE_WALK` in `src/lib/route-audit.ts` with `landsOn: '/line'`, and
      `npm run route:audit` passes with it in the list.
- [ ] `scripts/line-wizard.ts` gains the LIFF step: where in the console the LIFF app is
      added (inside the **LINE Login** channel, not the Messaging API one), what the
      endpoint URL must be (`https://<the shop's address>/line` — HTTPS is required by
      LINE), and `--verify` reports the LIFF door as open or shut beside the others.
- [ ] Unit tests for the pure entry (`tests/line-liff-entry.test.ts`): every decision
      above, each outcome's sentence present, and the unconfigured case winning over
      everything else.

## Notes

**Why it signs in and then gets out of the way.** The screens already exist and already
render inside LINE's browser (ADR 0030 §6 said so when it left LIFF out). Re-implementing
the catalogue and the order list for a narrower viewport would be a second renderer of
the same pages, which is the drift this repository refuses — so the entry's whole job is
the session and the phone when there is not one yet.

**Why the OTP stays even here.** The LIFF browser is the customer's own LINE account,
but the number is what is being anchored, and a person can type somebody else's. §1 of
ADR 0030 answers that with the OTP and this ticket does not reopen it.

**What cannot be proven from here, and will be said so in the ADR:** there is no LIFF
browser in this repository, so the handshake itself is unmeasured. What is measured is
the decision (pure, unit-tested) and the route the entry calls (already exercised by
`npm run acceptance` §20 with a stub token endpoint).
