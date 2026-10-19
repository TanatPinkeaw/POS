# 05: The counter sees whether the customer was told

**What to build:** one line on each waiting parcel's card saying whether the ready message went,
is queued, failed, or was never planned — and if not, why.

**Blocked by:** 01 (the reason vocabulary is `lineCustomerNotifyBlock`'s).
**Status:** done

- [x] `customerNoticeOutcome` in `line-notify.ts` — pure; the notification row wins (a row is
      the record), and with no row it re-derives from the same refusal the planner used.
- [x] Reasons cover both channels: the four LINE blocks, plus `no_channel` and `no_phone` for a
      webhook shop, which is the one requirement the LINE planner never meets.
- [x] `OrderListView.readyNotice` carries the outcome; `listOrderViews` reads it with **two**
      queries for the page (`notifications` for the waiting ids, `friendSubjects` for their
      customers), not one per row.
- [x] The customer's two LINE columns ride the existing include so the list does not pay a
      second read per member.
- [x] `PreOrderBoard` renders the sentence in a quiet style when it went and a warning colour
      when it did not; `not_ready` renders nothing.
- [x] `tests/line-notify.test.ts` pins the read-back: record first, `not_ready` silent, each
      reason's sentence, and `no_channel` vs `no_phone`.

## Notes

The line answers the question a cashier actually has — "will they know to come" — rather than
"was a row written". A parcel whose message never left used to look exactly like one that had
gone, which is the whole defect this feature was opened for.
