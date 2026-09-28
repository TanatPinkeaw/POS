import { DisplayScreen } from '@/components/display/DisplayScreen';

/**
 * The customer-facing screen (`/display`).
 *
 * Outside all three area layouts on purpose, beside `/login` and `/setup`: this
 * browser has no session and no account. It pairs once with a six-digit code an
 * admin shows it, keeps the token in `localStorage`, and from then on receives
 * only what the till chooses to send (see `src/lib/display-view.ts`).
 *
 * Nothing is loaded on the server here — there is no user to load it *for*. The
 * screen arrives paired or asking for a code, and then waits.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'จอลูกค้า',
};

export default function DisplayPage() {
  return <DisplayScreen />;
}
