import { MyOrders } from '@/components/shop/MyOrders';
import { PageHeader, Stack } from '@/components/ds';

/**
 * The page owns its `<h1>`, the same way the catalogue screen does: the component
 * below it is the list, and a component that renders a page title cannot be reused
 * anywhere else.
 */
export default function ShopOrdersPage() {
  return (
    <Stack gap="lg">
      <PageHeader
        title="ออเดอร์ของฉัน"
        subtitle="ติดตามสถานะพรีออเดอร์แบบเรียลไทม์ — อัปเดตทันทีที่ร้านแพ็กของเสร็จ"
      />
      <MyOrders />
    </Stack>
  );
}
