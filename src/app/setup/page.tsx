import { redirect } from 'next/navigation';

import { SetupWizard } from '@/components/setup/SetupWizard';
import { hasShop } from '@/lib/shop';

/**
 * First-run setup (ADR 0002).
 *
 * Outside the `(admin)`/`(pos)`/`(shop)` groups on purpose: there is no session
 * yet, so there is no shell to render, and borrowing one would mean the wizard
 * depended on the very accounts it exists to create.
 *
 * The gate below is the one that matters. `/setup` is a public path in
 * `roles.ts` because the proxy cannot reach the database from the edge runtime,
 * so the refusal is made here, on the Node runtime, where it can. The API also
 * checks, and the singleton primary key settles any race.
 */
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (await hasShop()) {
    redirect('/login');
  }

  return (
    <div className="container-fluid">
      <div className="row justify-content-center py-5">
        <div className="col-12 col-lg-8 col-xl-7">
          <div className="text-center mb-4">
            <h1 className="h4 mb-1">ตั้งค่าระบบครั้งแรก</h1>
            <p className="text-muted mb-0 small">
              ใช้เวลาประมาณ 2 นาที — ตั้งชื่อร้าน ภาษี และบัญชีผู้ดูแลระบบ
            </p>
          </div>

          <SetupWizard />
        </div>
      </div>
    </div>
  );
}
