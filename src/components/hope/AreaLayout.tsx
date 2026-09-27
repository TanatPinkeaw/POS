import type { ReactNode } from 'react';

import { RealtimeProvider } from '../realtime/RealtimeProvider';
import { AppShell, type NavItem, type ShellUser } from './AppShell';

/**
 * Server component that mounts the shell inside a realtime provider.
 *
 * A server component can render a client provider as long as the children are
 * passed through, which keeps each page a server component by default and only
 * makes the pieces that genuinely need the socket client-side.
 */
export function AreaLayout({
  user,
  nav,
  children,
}: {
  user: ShellUser;
  nav: NavItem[];
  children: ReactNode;
}) {
  return (
    <RealtimeProvider>
      <AppShell user={user} nav={nav}>
        {children}
      </AppShell>
    </RealtimeProvider>
  );
}
