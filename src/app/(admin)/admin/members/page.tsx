import { MembersManager, type MemberRow } from '@/components/admin/MembersManager';
import { PageHeader, Stack } from '@/components/ds';
import { bangkokDateString } from '@/lib/bangkok-time';
import { messageCountsForUsers } from '@/lib/line-messages';
import { listMembers } from '@/lib/members';
import { requireShellUser } from '@/lib/shell';

/**
 * Customers (ADR 0010).
 *
 * Admin-only, enforced by the layout and by every API this page calls. The list is
 * loaded on the server so the screen arrives with its rows rather than with a
 * spinner where the shop's customer list should be — the same reason the staff and
 * audit screens do it.
 */
export const dynamic = 'force-dynamic';

export default async function AdminMembersPage() {
  await requireShellUser(['admin']);

  const members = await listMembers();

  /*
   * One grouped query for the whole list rather than one per row, and only a count — the
   * messages themselves are behind a button (ADR 0032 §8). A shop with no LINE customers
   * gets an empty map and pays one query that finds nothing.
   */
  const messageCounts = await messageCountsForUsers(members.map((member) => member.id));

  const initialMembers: MemberRow[] = members.map((member) => ({
    id: member.id,
    fullName: member.fullName,
    phone: member.phone,
    email: member.email,
    isActive: member.isActive,
    pointsBalance: member.pointsBalance,
    orderCount: member.orderCount,
    // Formatted here rather than in the component so the browser's own time zone
    // cannot turn "joined on the 1st" into the 31st of the month before.
    joinedOn: bangkokDateString(new Date(member.joinedAt)),
    lineMessageCount: messageCounts.get(member.id) ?? 0,
  }));

  return (
    <Stack gap="lg">
      <PageHeader
        title="ลูกค้าและสมาชิก"
        subtitle="สมัครสมาชิกให้ลูกค้าที่หน้าร้าน ดูคะแนนสะสม และปิดบัญชีเมื่อลูกค้าขอยกเลิก"
      />

      <MembersManager initialMembers={initialMembers} />
    </Stack>
  );
}
