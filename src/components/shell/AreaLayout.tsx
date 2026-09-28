import type { ReactNode } from 'react';

import { ToastProvider } from '@/components/ds';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import { AppShell, type NavItem, type ShellUser } from './AppShell';

/**
 * Server component that mounts the frame inside its providers.
 *
 * A server component may render a client provider as long as the children are
 * passed through, which is what keeps every page a server component by default and
 * makes only the pieces that genuinely need the socket client-side.
 *
 * `density` is a property of the *area*, decided here once, rather than something
 * each screen chooses. A screen that could pick its own density would eventually
 * pick the wrong one, and the way that failure shows up is a mis-tapped payment
 * button on a Saturday.
 */
export function AreaLayout({
  user,
  nav,
  density = 'compact',
  variant = 'default',
  children,
}: {
  user: ShellUser;
  nav: NavItem[];
  density?: 'compact' | 'touch';
  variant?: 'default' | 'till';
  children: ReactNode;
}) {
  return (
    <RealtimeProvider>
      <ToastProvider>
        <AppShell user={user} nav={nav} density={density} variant={variant}>
          {children}
        </AppShell>
      </ToastProvider>
    </RealtimeProvider>
  );
}
