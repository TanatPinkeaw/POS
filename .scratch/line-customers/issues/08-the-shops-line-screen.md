# 08: The shop's LINE screen, and the requeue button that finally has a door

**What to build:** One screen for everything the shop does with LINE: what it can send,
who will get it, what it costs, what it has sent, and what did not go out.

**Blocked by:** 07 (there is no send route to compose into yet), 04 (the failed sends
list is the outbox's own list, which this screen surfaces beside them).
**Status:** done

- [ ] `/admin/line` — **admin only** (`PAGES` in `roles.ts`, `requireShellUser(['admin'])`
      in the layout/page, and the route handlers behind it), added to `ROUTE_WALK` with
      `landsOn: '/admin/line'`.
- [ ] The composer: the message text (Thai, one textarea — **no template editor**), an
      optional image link validated with `renderableImageUrl` and previewed with
      `probeImageUrl`/`Thumb` (`src/lib/image-url.ts` — the same reader a product photo
      and the shop logo already go through, including the Nextcloud share-link case),
      the **reachable count** (this deployment's own consented friends), and the
      **month's remainder** read from LINE. Pressing send is one confirmation showing the
      recipient count and the cost, then the campaign row.
- [ ] History: what was sent, when, by whom, to how many, and its status — with `partial`
      visible rather than hidden behind a success word.
- [ ] Not-delivered: the abandoned outbox messages (with their `last_error`) and a
      **requeue** button, which is a new route calling `requeueNotification` — the
      function has existed since ADR 0007 with a comment saying it is "the one repair a
      shop needs", and nothing has ever called it.
- [ ] A campaign whose batch failed can be **sent again by an admin** as a new campaign:
      the screen offers the failed campaign's text, not a silent retry.
- [ ] Every control: an `id`, a matching `<label for>`, an `aria-describedby` for its help
      or its error (rule 3), sizes from the density tokens (rule 4), semantic tokens only
      (rule 5), Thai copy that says what to do (rule 6).
- [ ] Tests: component/pure tests for the composer's derived numbers (cost, batches,
      remainder, refusals) and the requeue route against real Postgres (an abandoned row
      goes back to `pending` with its attempts reset; a row that is not abandoned is
      refused in Thai). `npm run route:audit` covers `/admin/line` for styling.

## Notes

**Why this screen exists at all.** A campaign is a send to the whole customer list: it
is the one act in this system whose mistake cannot be taken back, and it is the only
place where what the shop may send (consent), what it can afford (quota) and what it
actually sent (the record) are the same question. Spreading those three across settings,
the customer list and a dashboard would make each one answerable and none of them
together.
