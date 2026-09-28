import { redirect } from 'next/navigation';

import { SetupWizard } from '@/components/setup/SetupWizard';
import { hasShop } from '@/lib/shop';

import styles from './setup.module.css';

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
    <main className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.head}>
          <h1>ตั้งค่าระบบครั้งแรก</h1>
          <p className="ln-muted">
            ใช้เวลาประมาณ 2 นาที — ตั้งชื่อร้าน ภาษี และบัญชีผู้ดูแลระบบ
          </p>
        </header>

        <SetupWizard />
      </div>
    </main>
  );
}
