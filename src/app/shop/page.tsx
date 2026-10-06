import { redirect } from 'next/navigation';

/**
 * Where the customer's door used to be (ADR 0029).
 *
 * The door moved to `/login` — the address everything already pointed at: the
 * domain root, the proxy's refusals, `signOut`, bookmarks and printed QRs. This
 * path stays public in `roles.ts` and stays walked in `route-audit.ts` (`/shop`
 * landing on `/login`), so an old QR or a bookmark is answered by the door itself
 * rather than by a second sign-in page drifting away from it.
 */
export default function ShopSignInPage() {
  redirect('/login');
}
