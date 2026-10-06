import { PageHeader, Stack } from '@/components/ds';
import { AccountPortal } from '@/components/shop/AccountPortal';
import { prisma } from '@/lib/db';
import { lineBindingForUser } from '@/lib/line-identity';
import { requireShellUser } from '@/lib/shell';

/**
 * The customer's own account (ADR 0020, ADR 0021, ADR 0030).
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
 * The LINE state is read through `lineBindingForUser` for the same reason the phone
 * is read from the row: the card must show what is bound now, not what the session
 * claimed when it was minted.
 */
export default async function ShopAccountPage() {
  const user = await requireShellUser(['member']);
  const row = await prisma.users.findUnique({
    where: { id: user.id },
    select: { phone: true },
  });

  /*
   * Null only when the row has vanished since the shell loaded it — an edge no
   * customer will meet — and the card renders "not bound" for it, which is the
   * honest answer for a row that no longer exists.
   */
  const line = await lineBindingForUser(user.id);

  return (
    <Stack gap="lg">
      <PageHeader title="บัญชีของฉัน" subtitle="คะแนน ใบเสร็จ เบอร์โทรศัพท์ และ LINE ของคุณ" />
      <AccountPortal
        phone={row?.phone ?? ''}
        pointsBalance={user.pointsBalance}
        line={{
          lineSubject: line?.lineSubject ?? null,
          consentAt: line?.consentAt ? line.consentAt.toISOString() : null,
          consentVersion: line?.consentVersion ?? null,
        }}
      />
    </Stack>
  );
}
