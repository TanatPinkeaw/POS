import Link from 'next/link';

import { ReceiptReprintButton } from '@/components/admin/ReceiptReprintButton';
import { SalesChart } from '@/components/admin/SalesChart';
import { Badge, Card, EmptyState, Money, StatCard } from '@/components/hope/ui';
import { dashboardSnapshot } from '@/lib/analytics';

/** SRS §2: sales dashboard and financial analytics are admin-only. */
export default async function DashboardPage() {
  const snapshot = await dashboardSnapshot();

  type Tone = 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info';

  const statusTone: Record<string, Tone> = {
    pending: 'warning',
    confirmed: 'info',
    ready_for_pickup: 'primary',
    completed: 'success',
    cancelled: 'danger',
  };

  const statusLabel: Record<string, string> = {
    pending: 'รอยืนยัน',
    confirmed: 'กำลังเตรียม',
    ready_for_pickup: 'พร้อมรับ',
    completed: 'สำเร็จ',
    cancelled: 'ยกเลิก',
  };

  return (
    <div className="d-flex flex-column gap-4">
      <div>
        <h4 className="mb-1">ภาพรวมวันนี้</h4>
        <p className="text-muted mb-0 small">
          ข้อมูลสดจากฐานข้อมูล — ยอดขายนับเฉพาะออเดอร์ที่ปิดการขายแล้ว
        </p>
      </div>

      <div className="row g-3">
        <div className="col-12 col-md-6 col-xl-3">
          <StatCard label="ยอดขายวันนี้" value={<Money amount={snapshot.today.salesThb} />} hint={`${snapshot.today.orderCount} ออเดอร์`} />
        </div>
        <div className="col-12 col-md-6 col-xl-3">
          <StatCard
            label="เงินสดในลิ้นชัก"
            value={<Money amount={snapshot.today.cashThb} />}
            hint="เฉพาะที่ชำระด้วยเงินสด"
            tone="success"
          />
        </div>
        <div className="col-12 col-md-6 col-xl-3">
          <StatCard
            label="พร้อมเพย์"
            value={<Money amount={snapshot.today.promptpayThb} />}
            hint="ไม่นับเป็นเงินสดตอนปิดกะ"
            tone="info"
          />
        </div>
        <div className="col-12 col-md-6 col-xl-3">
          <StatCard
            label="มูลค่าสต็อก (ทุน)"
            value={<Money amount={snapshot.catalogue.stockValueAtCostThb} />}
            hint={`${snapshot.catalogue.activeProducts} รายการ · จองไว้ ${snapshot.catalogue.reservedUnits} ชิ้น`}
            tone="warning"
          />
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-8">
          <Card title="ยอดขาย 7 วันย้อนหลัง" subtitle="รวมออเดอร์ที่ปิดการขายแล้ว">
            <SalesChart data={snapshot.salesByDay} />
          </Card>
        </div>

        <div className="col-12 col-xl-4">
          <Card title="พรีออเดอร์ตามขั้นตอน" subtitle="SRS §3 — วงจร 4 ขั้นตอน">
            <ul className="list-group list-group-flush">
              {(
                [
                  ['1. รอยืนยัน', snapshot.preOrders.pending, 'warning'],
                  ['2. กำลังเตรียม', snapshot.preOrders.confirmed, 'info'],
                  ['3. พร้อมรับ', snapshot.preOrders.readyForPickup, 'primary'],
                  ['4. ปิดการขายวันนี้', snapshot.preOrders.completedToday, 'success'],
                  ['ยกเลิก/หมดอายุวันนี้', snapshot.preOrders.cancelledToday, 'danger'],
                ] as const
              ).map(([label, count, tone]) => (
                <li key={label} className="list-group-item d-flex justify-content-between align-items-center px-0">
                  <span>{label}</span>
                  <Badge tone={tone}>{count}</Badge>
                </li>
              ))}
            </ul>

            <Link href="/pos/preorders" className="btn btn-sm btn-primary w-100 mt-3">
              เปิดกระดานพรีออเดอร์
            </Link>
          </Card>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-6">
          <Card title="สินค้าใกล้หมด" subtitle="นับจากจำนวนที่ขายได้จริง (คงเหลือ − จองไว้)">
            {snapshot.lowStock.length === 0 ? (
              <EmptyState title="สต็อกทุกรายการเพียงพอ" />
            ) : (
              <div className="table-responsive">
                <table className="table table-sm mb-0">
                  <thead>
                    <tr>
                      <th>สินค้า</th>
                      <th className="pos-numeric">คงเหลือ</th>
                      <th className="pos-numeric">จองไว้</th>
                      <th className="pos-numeric">ขายได้</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.lowStock.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <span className="d-block">{row.name}</span>
                          {row.barcode && (
                            <span className="text-muted small">{row.barcode}</span>
                          )}
                        </td>
                        <td className="pos-numeric">{row.stockQty}</td>
                        <td className="pos-numeric text-muted">{row.reservedQty}</td>
                        <td className="pos-numeric">
                          <Badge tone={row.availableQty <= 0 ? 'danger' : 'warning'}>
                            {row.availableQty}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="col-12 col-xl-6">
          <Card title="ออเดอร์ล่าสุด" subtitle="ทุกช่องทาง ทั้งหน้าร้านและออนไลน์">
            {snapshot.recentOrders.length === 0 ? (
              <EmptyState title="ยังไม่มีออเดอร์" description="เริ่มขายที่หน้าร้านเพื่อดูข้อมูลที่นี่" />
            ) : (
              <div className="table-responsive">
                <table className="table table-sm mb-0">
                  <thead>
                    <tr>
                      <th>เลขที่</th>
                      <th>ประเภท</th>
                      <th>สถานะ</th>
                      <th>พนักงาน</th>
                      <th className="pos-numeric">ยอด</th>
                      <th>
                        <span className="visually-hidden">ใบเสร็จ</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.recentOrders.map((order) => (
                      <tr key={order.id}>
                        <td>
                          <code className="small">{order.orderNumber}</code>
                        </td>
                        <td>
                          <Badge tone={order.orderType === 'preorder' ? 'info' : 'secondary'}>
                            {order.orderType === 'preorder' ? 'ออนไลน์' : 'หน้าร้าน'}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone={statusTone[order.status] ?? 'secondary'}>
                            {statusLabel[order.status] ?? order.status}
                          </Badge>
                        </td>
                        <td className="small">{order.cashierName ?? '—'}</td>
                        <td className="pos-numeric">
                          <Money amount={order.finalAmountThb} />
                        </td>
                        <td className="text-end">
                          {/*
                            * Only a completed sale has a receipt; offering the
                            * button elsewhere would promise a document that
                            * does not exist yet.
                            */}
                          {order.status === 'completed' && (
                            <ReceiptReprintButton orderId={order.id} orderNumber={order.orderNumber} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
