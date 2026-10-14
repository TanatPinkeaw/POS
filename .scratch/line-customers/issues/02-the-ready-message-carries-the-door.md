# 02: The "order is ready" message carries the door

**What to build:** The message a customer already gets when their parcel is packed ends
with a link into `/line`, so one tap opens their order screen inside LINE with the
session the LIFF entry just made.

**Blocked by:** 01 (the entry has to exist and be configurable before a message can
point at it).
**Status:** done

- [ ] `liffEntryUrl()` — one builder, in `src/lib/line-liff-entry.ts`, returning
      `https://liff.line.me/<liffId>` when `LINE_LIFF_ID` is set and `null` when it is
      not, **exactly the shape `lineRedirectUri` already has** for the callback: one
      function, every caller, because LINE compares addresses character for character
      and a second assembly is how one of them drifts.
- [ ] `planLineCustomerReadyMessage` appends the link only when it exists. A shop with
      no LIFF app configured sends exactly the sentence it sends today — the message is
      not broken by a feature it has not set up.
- [ ] The appended text is checked against `MAX_TEXT_LENGTH` (200) in a test, because
      that tripwire exists for the webhook channel and this is the first time the LINE
      message has grown a URL.
- [ ] `tests/line-liff-entry.test.ts` (or the notify test beside it) asserts both
      shapes: with a `liffId` the text ends with the link, without one it is unchanged.

## Notes

The trade is stated in the ADR: a URL inside the message is real estate the customer
reads, and a link that opens into the app they are already in is worth more than a
shorter sentence. It is also the first thing in this repository that points a customer
*into* LINE rather than out of it.
