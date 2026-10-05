# ADR 0028 — The shop says whether it takes pre-orders

**Status:** accepted (2026-10-05). It amends the "One switch only" bullet of ADR 0027, which
was written the day before on the evidence available then and named pre-orders as a switch
that was *not* yet due.

**Context:** A pre-order is a customer buying something the shop has not handed over yet: the
member orders on the way there, the drink is waiting, and it is paid for at handover. That is
only worth having if the shop prepares ahead. A shop that sells what is on the shelf has
nothing to prepare, and the feature took three pieces of its customer-facing screen anyway
(ADR 0025): a basket on the right, a plus/minus pair on every tile that only exists to fill
that basket, and a `จองสินค้า (พรีออเดอร์)` button that leads to a shop which will not take
the order. The till's navigation held a pre-order board for the same shop.

The question was asked nowhere, exactly as in ADR 0027, so there was nothing to answer. And the
temptation was the same: answer it with a shop type.

The two switches are independent, and that is the reason not to reach for a type again. A shop
can take orders by phone, prepare them and hand them over the moment the customer walks in —
pre-orders on, queue numbers off, because nothing ever waits. The mirror image is the shop ADR
0027 is for: a queue of names being called, and no ordering ahead at all. One type would have to
decide both, and would decide them wrong for whichever shop it did not have in mind.

## Decisions

1. **One boolean on the shop row, not a shop type.** `shops.accepts_preorders`, default true,
   NOT NULL, beside `calls_numbers` and independent of it. Rejected: extending `calls_numbers`
   into one "counter style", and a shop type, for the reasons in ADR 0027 §1 — a single
   question deserves a single switch, and two shops that disagree about one half of the answer
   should not be forced to agree about the other half too.

2. **The switch is obeyed where the order is placed.** `placePreOrder` reads the column inside
   its transaction, before `priceCart`, and raises `ConflictError('ร้านนี้ยังไม่เปิดรับพรีออเดอร์')`
   before an order row exists, before the `PO-` sequence is spent and before any stock moves
   into `reserved_qty`. A member's browser is the only way into that function, so a rule that
   lived in the route or in the storefront would be one refactor away from a pre-order nobody
   asked for. Rejected: hiding the button. The button is what makes the refusal *reachable*
   rather than mysterious — a member with the page already open is answered in Thai instead of
   watching a basket do nothing.

3. **The read does not take the shop row's lock.** Deliberate, and in the other direction from
   ADR 0027, where the switch had to be read inside the statement that bumps a counter. This
   one value does not have to be current to the instant: an owner who closes pre-orders while an
   order is in flight gets that order and refuses the next, which is what they meant. Locking
   the shop row here would put a lock in front of the product rows `priceCart` reads and risk
   inverting the order ADR 0019 settled. The order number comes from a sequence, so nothing is
   spent on the way to the refusal.

4. **Default true, and the migration takes nothing away.** The column's default is the only value
   any row has ever had, exactly as in ADR 0027 §3.

5. **The storefront becomes a catalogue, not a basket with nothing in it.** The split pane, the
   per-tile steppers and the placing button are removed together rather than one at a time: the
   steppers only exist to fill a basket that is not there, and two `+`/`−` buttons that do
   nothing read as a broken page rather than as a shop that does not take pre-orders. What is
   left says the same sentence the server refuses with, so a member who watched the shop close it
   reads one answer in both places.

6. **The till's navigation hides the board; the board itself keeps working.** Hiding the nav
   item follows ADR 0027 §4. Unlike the queue board, the route is not dead while the switch is
   off: a shop that closes pre-orders today still has yesterday's pending orders to prepare,
   hand over and settle, and the board is where that work is listed. Hiding a screen that still
   has live work on it would be hiding a queue.

7. **A prepared device needs to know nothing.** The till never places a pre-order, so the switch
   does not ride in the device snapshot (ADR 0019) and no offline rule reads it. This is the
   one place where the shape of ADR 0027 §5 deliberately does not repeat, and the reason is
   that there is no offline path into `placePreOrder` to govern.

8. **The wizard asks, the settings page is the switch's home, and a settings save always sends
   both keys.** The wizard's toggle defaults to the column's default; the settings form always
   sends `callsNumbers` and `acceptsPreorders`, because a save that left them out would be a save
   that could not turn them off. The payload still *accepts* their absence — an older client, or
   the setup path, may omit a key it was never asked about, and `shopColumns` writes only what it
   is given.

## Consequences and gaps

- **Orders already placed stay on the board** and must still be fulfilled, confirmed and
  settled. The switch governs new orders only; nothing writes backwards and no reservation is
  released, because a member was promised that drink.
- **The counter that a closed shop stops moving does not exist here.** Unlike the queue counter
  (ADR 0027), no number is spent by a refusal — the sequence advances only inside a transaction
  that committed, so a shop that closes pre-orders and reopens them picks up its own sequence
  where it stopped, with no gap for the refused attempts to leave.
- **The member storefront's own copy had to change with it.** `ยังไม่มีสินค้าให้จอง` ("no
  products to pre-order") is a lie on a page that no longer offers pre-orders, so the empty state
  and the card title both follow the switch.
- **A shop that closes pre-orders mid-shift is not warned** that members are holding orders it
  has agreed to prepare. Nothing counts pending orders against the switch; an owner has to look at
  the board, which is still there.
- **Nothing notices a shop that answers wrongly.** A grocer who leaves the switch on keeps a
  basket that leads to an order nobody confirms before the deadline, and the sweeper cancels it —
  the same as it did before this switch existed.
- **Measured:** `tests/shop-accepts-preorders.test.ts` — a closed shop refuses in the member's
  own language with a `ConflictError` and writes no order, a shop that takes them still places
  one, and a settings save writes the column only when it was sent the key.
