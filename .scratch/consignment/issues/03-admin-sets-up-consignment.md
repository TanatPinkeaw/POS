# 03: An admin consigns a product, and withdraws it

**What to build:** An admin can put a product into consignment with a member and a percentage,
change the terms, and withdraw unsold goods — each an audited act.

**Blocked by:** 01.
**Status:** ready-for-agent

- [ ] Set `consignor_user_id` and `consignor_share_percent` at `/admin/products`, admin-only.
- [ ] A consignor must be an existing `member`; a product already sold cannot change owner.
- [ ] Withdrawing unsold goods is a stock adjustment with an SRS §4.3 movement and an audit
      row — never a silent delete.
- [ ] Changing the percent is audited with the old and new value.
- [ ] Tests: a non-member is refused; a change after a sale is refused or recorded, per the
      decision taken while building; withdrawal writes the movement.

## Notes

Only an admin, because goods belonging to somebody else inside the shop is a liability
(ADR 0023 §1). The screen reuses the existing product admin surface.
