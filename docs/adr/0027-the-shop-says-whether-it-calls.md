# ADR 0027 — The shop says whether it calls its customers

**Status:** accepted (2026-10-05). It amends ADR 0017 §1 and ADR 0018's premise, both of
which were written as universal: every walk-in bill gets a short number, and every shop gets
the board that calls it.

**Context:** A shop that sells goods over the counter hands the customer their bag and closes
the bill in the same breath. Nothing is waiting, so nobody is ever called — and the feature
still took two pieces of that shop's screen. The number is printed at the largest size the
80mm sheet carries, above the document's own number, on every single bill (ADR 0017 §6). The
board gets a page in the till's navigation (ADR 0018). Both are correct for a coffee shop and
both are noise for a grocer, and the repository had no way to tell the two apart: the
question was asked nowhere, so there was nothing to answer.

The temptation was to answer it with a shop type.

## Decisions

1. **One boolean on the shop row, not a shop type.** `shops.calls_numbers`, default true,
   NOT NULL. Rejected: `shop_type ∈ {drinks, goods}`. A type has to decide the behaviour of
   features that have nothing to do with each other, and it decides them behind the shop's
   back — the shop is told "you sell goods", a customer asks for their number, and there is
   no switch anybody set. One switch per job, each set by the shop in its own words, can be
   wrong one at a time and be corrected one at a time.

2. **The switch is obeyed by the sale, not by the screens.** `allocateQueueNumber` reads
   `calls_numbers` inside the statement that would have bumped the counter, and
   `createPosSale` mints a fulfilment ticket only when it has a number to call. Everything
   downstream — the printed slip (`{data.queueNumber ? …}`), the queue board, the customer
   display's list of ready numbers — reads the number off the bill, so all of them correct
   themselves. Rejected: hiding the number on the receipt only. That leaves the counter
   burning through the day's series for bills nobody can be called for, and leaves the board
   full of tickets that mean nothing.

3. **Default true, and the migration is not the moment to take anything away.** The column's
   default is the only value any row has ever had. A shop upgrading keeps being called by the
   numbers it was being called by; the shops that never wanted it turn it off in the settings,
   which is two taps and reversible.

4. **The till's navigation hides the queue, the route does not.** A page in the navigation a
   shop has said it does not have is a page somebody taps to find out, and the answer is a
   screen of nothing. The route stays, so a shop that turns the setting back on has somewhere
   to land and an old bookmark stops being a dead end.

5. **A prepared device obeys the switch too, and stops borrowing what it will not spend.**
   The answer rides in the device snapshot (ADR 0019), so a device prepared before the change
   hears the new answer on its next read rather than at the next `prepare`. `prepare` no longer
   borrows the two days of call numbers, and the offline rules neither spend a number nor raise
   the "no call number" shortfall warning for a shop that issues none — running out of a series
   nobody uses is not a shortfall. A borrowed block is left unspent rather than released, because
   releasing a range mid-shift is a return of numbers that may already have gone out on paper.

6. **The wizard asks, and the answer is editable.** One more toggle on the step that already
   owns the slip, defaulting to the column's default. Not a shop-type question with
   consequences: a shop that is unsure turns it off later, and the settings page says what it
   does in a line.

## Consequences and gaps

- **Existing bills keep their numbers.** Turning the switch off writes nothing backwards: a slip
  printed yesterday still prints its number on a reprint, because a number that went out on paper
  has to stay printable. The switch governs new bills only.
- **The counter does not move while the switch is off**, deliberately — read inside the
  statement. A shop that turns calling back on starts the day at the number it would have had,
  rather than at a number nobody was ever called by.
- **`orders.fulfilment` gains a state it already had.** Null used to mean "a pre-order, or a
  bill from before the machine existed"; it now also means "this shop does not call". Nothing
  reads the column to mean anything else, and the board already treats null as "no goods
  waiting".
- **One switch only.** Pre-orders, loyalty and consignment all have the same shape of argument
  and none of them has a shop that has asked to be rid of it, so no switch is added for them.
  When one is, it is one column and one branch in the sale — this ADR is the pattern, not a
  licence to pre-build.
- **A shop that is wrong about itself is not diagnosed.** Nothing here notices a grocer that
  turns the switch on and never uses the board; the number simply appears on the slips.
- **Measured:** `tests/shop-calls-numbers.test.ts` — off gives no number and no ticket, the day's
  counter does not move while off and continues from where it stopped when the switch returns, the
  statement that bumps it hands back nothing, a settings save that does not mention the column
  leaves it alone, a device neither borrows the queue series nor spends one nor warns about
  running short, and the block is untouched so switching back on still has numbers.