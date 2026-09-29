import { PageHeader, Stack } from '@/components/ds';
import { QueueBoard } from '@/components/pos/QueueBoard';

/**
 * The bar's screen (ADR 0018).
 *
 * Its own page rather than a panel on the register, because it is a different job
 * on the same shop: the person making drinks is not the person taking money, and
 * on a slow afternoon they are the same person who does not want the board
 * competing with the catalogue for the screen they are ringing up on.
 *
 * Nothing is read here on the server — the board is live and reads itself — so this
 * page is a heading and a component.
 */
export default function QueuePage() {
  return (
    <Stack gap="lg">
      <PageHeader
        title="คิวเครื่องดื่ม"
        subtitle="คิวของบิลที่ขายแล้วและยังไม่ได้ส่งมอบ — กด เสร็จแล้ว เมื่อทำเสร็จ เลขจะขึ้นจอลูกค้า กด รับแล้ว เมื่อส่งมอบ"
      />
      <QueueBoard />
    </Stack>
  );
}
