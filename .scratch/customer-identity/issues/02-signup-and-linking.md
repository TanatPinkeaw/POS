# 02: Two doors to a customer, and one identity per phone

**What to build:** A customer signs up with Google and a verified phone, or is enrolled at the
counter; a returning member's Google sign-in links to the row that already owns their number.

**Blocked by:** 01.
**Status:** ready-for-agent

- [ ] Self-signup: Google, then a phone confirmed by OTP, creating a `member`.
- [ ] Counter enrolment (ADR 0011) unchanged and still working, with no Google required.
- [ ] A first Google sign-in with a phone that already belongs to a member **links** to that
      row after OTP proves possession — never a second row, never a refused sign-in.
- [ ] The phone stays unique across every role; a number a staff account holds is refused as a
      customer, and vice versa.
- [ ] `/shop` offers both doors side by side; neither is hidden.
- [ ] Tests: linking keeps the points and the order history on one row; a second sign-up
      cannot take a number already owned; a walk-in enrols and later links without a second
      customer.

## Notes

The failure to prevent is a split balance (ADR 0020 §4). "Link, never duplicate" is the whole
ticket.
