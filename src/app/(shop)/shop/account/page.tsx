import { PageHeader, Stack } from '@/components/ds';
import { AccountPortal } from '@/components/shop/AccountPortal';
import { prisma } from '@/lib/db';
import { requireShellUser } from '@/lib/shell';

/**
 * The customer's own account (ADR 0020, ADR 0021).
 *
 * Member-only, and it says so twice: the page matrix refuses every other role at the
 * proxy, and `requireShellUser(['member'])` refuses them again here, where the data
 * is actually sent. The phone is read from the row rather than taken from the session
 * token, so what the portal shows is the number that is true *now* — including
 * immediately after a change made on this same screen.
 *
 * The consignment offer form lives inside the ฝากขาย tab rather than on a route of its
 * own (ADR 0025): it is one panel of this account, and a member who came to ask where
 * their goods stand should not have to find a second place to send new ones from.
 */
export default async function ShopAccountPage() {
  const user = await requireShellUser(['member']);
  const row = await prisma.users.findUnique({
    where: { id: user.id },
    select: { phone: true },
  });

  return (
    <Stack gap="lg">
      <PageHeader title="บัญชีของฉัน" subtitle="คะแนน ใบเสร็จ และเบอร์โทรศัพท์ของคุณ" />
      <AccountPortal phone={row?.phone ?? ''} pointsBalance={user.pointsBalance} />
    </Stack>
  );
}
