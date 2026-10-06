# ADR 0029 — The front door belongs to the customer

**Status:** accepted (2026-10-06).

**Context:** This deployment has one sign-in URL a person can be *given*: `/login` is where the
domain root sends the signed-out, where the proxy sends the refused, where `signOut` lands,
and what bookmarks and printed QR codes hold. Until now that screen opened on the **staff
form** — phone, password, and (on a seeded database) a table of demo accounts. The customer's
own doors (ADR 0020) lived a second URL away at `/shop`, which nothing inside the application
linked to: a customer standing at the counter, handed the shop's address, arrived at a wall of
someone else's UI and had to be told a second address to reach their own door.

The request that surfaced it was plain: the ordinary login page should be the customer's, and
staff should tap their way in separately.

## Decisions

1. **`/login` renders the customer's two doors.** `CustomerSignIn` — Google plus the counter's
   phone-and-password, exactly the doors ADR 0020 §3 specifies, privacy notice at the footer
   included — moved to the front door. The screen keeps `data-density="touch"`: with no
   session there is no way to tell a phone from a till tablet, and the customer's phone is the
   likelier of the two. Rejected: keeping two full sign-in screens. Two implementations of
   "the way in" drift apart — the old pair already disagreed about density, demo accounts and
   the privacy scrim — and every printed QR has to name one address, not two.

2. **The staff form folds behind one toggle below the card.** `StaffDoorToggle` renders a
   quiet text-style button (`พนักงานเข้างาน`); pressing it mounts `LoginForm` unchanged. Below
   the card rather than inside it: a customer scanning the card must not have to read past
   anything about staff, and a member of staff arriving at a wall of customer copy still finds
   their own door at the bottom of the page. `LoginForm` mounts only when opened because its
   identifier field carries `autoFocus` — fired on page load it would steal focus from the
   Google button a customer was about to press. The button carries `aria-expanded` and
   `aria-controls`, so the fold is announced rather than silent.

3. **`/shop` redirects to `/login` and stays public.** The path remains in `isPublicPath` so
   the *page's own* redirect answers an old QR or bookmark; dropping it from the public list
   would make the proxy answer instead, and the proxy's bounce is a different, worse experience
   (a second round trip through a guard for a redirect the page could have given directly).
   The route walk pins `/shop → landsOn /login`, so `route:audit` proves the redirect on a
   real server rather than trusting the source. No data ever lived at `/shop` itself — the
   guarded area behind it (`/shop/products`, `/shop/orders`, `/shop/account`) is untouched,
   and `requiredRolesForPath('/shop')` returning every role is unchanged, because the redirect
   page has nothing to protect.

4. **The demo accounts moved inside the fold.** They render only inside the staff panel and
   only while the seeded manager account exists, as before — but they no longer sit above the
   fold on the screen customers see first. A table of staff phone numbers is advertising to
   exactly the wrong audience on the page whose job is to be the customer's.

5. **The stylesheet moved with the door.** `shop-signin.module.css` became
   `login/customer-signin.module.css`: `/login` is now the only screen that renders it, and a
   stylesheet owned by a redirect page was a breadcrumb pointing at a screen that no longer
   exists. `CustomerSignIn`'s import path is the only reference that changed.

## Consequences and gaps

- **Staff reach their form in one tap, not zero.** The door that costs nothing is the
  customer's; the staff door costs one tap. If that tap proves to be a daily annoyance at a
  counter — the evidence does not exist yet either way — the answer is a *separate address*
  for staff, which would reintroduce a second screen to keep in step; it should be decided on
  that evidence, not in anticipation of it.
- **The Google door's configuration notice now shows on the front door too.** A deployment
  without `GOOGLE_CLIENT_ID` prints "ร้านนี้ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google" to
  customers who arrive at `/login` rather than only to those who find `/shop` — which is more
  honest, since that is where customers actually are.
- **`/shop` is a redirect, not a screen.** It appears in no nav, and `route:audit` walks it to
  prove where it lands; a screen that renders nothing is also a screen that cannot drift.
- **Measured:** `tests/login-staff-door.test.ts` — the front door renders `CustomerSignIn` and
  reaches `LoginForm` only through `StaffDoorToggle`, the demo block renders only inside the
  fold, `/shop`'s source is a redirect, `/shop` stays public, and the route walk pins
  `/shop → /login`. The redirect itself is exercised against a built server by `route:audit`.
