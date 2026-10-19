# 08: The receipt link rides the message, and says when it dies

**What to build:** after handover the customer gets their receipt link on their own LINE, with
the expiry printed in the sentence.

**Blocked by:** 06.
**Status:** done

- [x] `planLineCustomerReceiptMessage` — order number, the signed URL, and
      `ลิงก์ใช้ได้ถึง HH:MM น.` plus where to reopen it afterwards.
- [x] `completeOrder` computes `receiptLinkExpiry({ soldAt: at, now: at })` **once** and mints
      with `createReceiptToken`, so the printed time and the token's own expiry cannot differ
      by the milliseconds of two `new Date()` calls.
- [x] Guarded twice: no `PUBLIC_BASE_URL` means no message (a link naming `localhost` sends the
      customer to their own phone — `public-url.ts` records why a route cannot derive the
      address), and a null expiry means no message rather than a dead link.
- [x] `order_receipt` is its own kind, so one handover is one receipt message.
- [x] The default TTL is untouched (`RECEIPT_LINK_TTL_MINUTES`, 60) — the message adapts to the
      link, not the other way round, because the link's life is an access rule (ADR 0021).

## Notes

The rejected alternative — "ใบเสร็จพร้อมแล้ว เปิดที่หน้าออเดอร์" with no credential — is recorded
in ADR 0035. The customer asked for the receipt at the counter; a link is what they can keep.
The exposure is bounded: one order, one hour, the person who paid.
