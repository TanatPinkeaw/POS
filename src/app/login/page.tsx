import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/auth/LoginForm';
import { getSessionUser } from '@/lib/auth';
import { homePathForRole } from '@/lib/roles';

/**
 * Demo accounts seeded by `npm run db:seed`.
 *
 * Listed on the sign-in card on purpose: this is a local development build, and
 * having the three roles one tap away is what makes the RBAC behaviour easy to
 * check. Remove this block before any real deployment.
 */
const DEMO_ACCOUNTS = [
  { role: 'ผู้จัดการ (Admin)', phone: '0800000001' },
  { role: 'แคชเชียร์ (Employee)', phone: '0800000002' },
  { role: 'พนักงานสต็อก (Employee)', phone: '0800000003' },
  { role: 'สมาชิก (Member)', phone: '0900000001' },
];

export default async function LoginPage() {
  const session = await getSessionUser();
  if (session) {
    redirect(homePathForRole(session.role));
  }

  return (
    <div className="container-fluid">
      <div className="row justify-content-center align-items-center" style={{ minHeight: '100vh' }}>
        <div className="col-12 col-md-8 col-lg-5 col-xl-4">
          <div className="card">
            <div className="card-body p-4">
              <div className="text-center mb-4">
                <div className="logo-main d-flex justify-content-center mb-2">
                  <svg className="text-primary" width="40" height="40" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="-0.76" y="19.24" width="28" height="4" rx="2" transform="rotate(-45 -0.76 19.24)" fill="currentColor" />
                    <rect x="7.73" y="27.73" width="28" height="4" rx="2" transform="rotate(-45 7.73 27.73)" fill="currentColor" />
                    <rect x="10.54" y="16.39" width="16" height="4" rx="2" transform="rotate(45 10.54 16.39)" fill="currentColor" />
                    <rect x="10.56" y="-0.56" width="28" height="4" rx="2" transform="rotate(45 10.56 -0.56)" fill="currentColor" />
                  </svg>
                </div>
                <h4 className="mb-1">POS Realtime</h4>
                <p className="text-muted mb-0 small">
                  ระบบขายหน้าร้าน สต็อกเรียลไทม์ และพรีออเดอร์ 4 ขั้นตอน
                </p>
              </div>

              <LoginForm />

              <hr className="my-4" />

              <div className="small">
                <p className="text-muted mb-2">
                  บัญชีทดลอง — รหัสผ่านทั้งหมดคือ <code>password123</code>
                </p>
                <ul className="list-unstyled mb-0">
                  {DEMO_ACCOUNTS.map((account) => (
                    <li key={account.phone} className="d-flex justify-content-between py-1">
                      <span className="text-muted">{account.role}</span>
                      <code>{account.phone}</code>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
