# 02: The wizard stops guessing

**What to build:** `npm run line:wizard -- --verify` prints the shared readiness model instead
of its own summary line.

**Blocked by:** 01.
**Status:** done

- [x] Delete the inline `messagingSecret && pushToken` / `loginId && loginSecret` / `liffId`
      blocks. They answered a different question from the one the code asks.
- [x] Print one line per door: `✓` ready, `✗` blocked (the state that sends nothing while
      looking configured), `·` off (a shop that works without it).
- [x] When anything is blocked, print the file-versus-process note: this reads `.env`; the
      running server holds what it read at boot, so `/admin/line` is the other reader.
- [x] Keep the `LINE_API_BASE_URL` warning and the callback-URL list unchanged.
- [x] `tests/line-wizard.test.ts` pins the shape: the script imports the module, no longer
      contains the old printed literal or its condition, and says where the other reader lives.

## Notes

The docstring still quotes the old sentence on purpose — a reader deserves to know what was
wrong — which is why the test asserts the *printed literal* rather than the phrase.
