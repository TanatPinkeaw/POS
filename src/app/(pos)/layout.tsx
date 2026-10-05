import { OfflineShellRegistrar } from '@/components/pos/OfflineShellRegistrar';
import { AreaLayout } from '@/components/shell/AreaLayout';
import type { NavItem } from '@/components/shell/AppShell';
import { requireShellUser } from '@/lib/shell';
import { loadShop } from '@/lib/shop';

const POS_NAV: NavItem[] = [
  { href: '/pos', label: 'ขายหน้าร้าน', icon: 'cart' },
  { href: '/pos/queue', label: 'คิวเครื่องดื่ม', icon: 'bell' },
  { href: '/pos/preorders', label: 'พรีออเดอร์', icon: 'receipt', badgedByPreOrders: true },
  { href: '/pos/attendance', label: 'ลงเวลาทำงาน', icon: 'clock' },
];

/**
 * The way back out of the till, for an administrator only.
 *
 * The admin nav offers `/pos` and `/pos/preorders`, so an owner can step onto the
 * counter from the back office — and until this existed there was no way back:
 * the till's own nav is three items long, none of them `/admin`, and the sidebar in
 * here is the only navigation there is. Leaving the area was a URL somebody had to
 * know.
 *
 * Administrators only. An employee who tapped this would be sent to `/login` by
 * `requireShellUser(['admin'])` — a nav item that logs a cashier out is worse than
 * a nav item that is not there.
 */
const ADMIN_RETURN: NavItem = {
  href: '/admin/dashboard',
  label: 'กลับหน้าจัดการ',
  icon: 'dashboard',
};

/**
 * SRS §2: the POS terminal is for employees and admins.
 *
 * The one area that runs at `touch`: it is used on a tablet on a counter, with a
 * thumb, often while looking at the customer, so its controls are 48px and up and
 * its type is 16px. The till variant also gives the selling area the whole
 * viewport instead of padding it like a document.
 */
export default async function PosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireShellUser(['employee', 'admin']);
  /*
   * The drinks queue is offered only to a shop that calls its customers by number
   * (ADR 0027), and the pre-order board only to a shop that takes them (ADR 0028).
   * Hidden rather than disabled: a page in the navigation that a shop has said it
   * does not have is a page somebody taps to find out, and the answer is a screen
   * of nothing. The routes themselves stay, so a shop that turns a setting back on
   * has somewhere to land — and an old bookmark stops being a dead end rather than
   * becoming a 404 that looks like a bug.
   *
   * An unconfigured shop (no row at all) keeps every item: the switches default to
   * on, and a nav that hides features before anybody has chosen is the wrong way to
   * be wrong.
   *
   * `loadShop` is one indexed read of a one-row table, per navigation, and it is
   * the same read the till page already makes for the shop it prints on.
   */
  const shop = await loadShop();
  const items = shop
    ? POS_NAV.filter((item) => {
        if (item.href === '/pos/queue') return shop.callsNumbers;
        if (item.href === '/pos/preorders') return shop.acceptsPreorders;
        return true;
      })
    : POS_NAV;
  const nav = user.role === 'admin' ? [...items, ADMIN_RETURN] : items;
  return (
    <AreaLayout user={user} nav={nav} density="touch" variant="till">
      {/*
        So a prepared till can be opened with the network gone (ADR 0024). In the till area
        and nowhere else, and in a production build only — see the component for why both
        of those are deliberate rather than incidental.
      */}
      <OfflineShellRegistrar />
      {children}
    </AreaLayout>
  );
}
