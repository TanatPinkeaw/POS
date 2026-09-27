import { redirect } from 'next/navigation';

import { getSessionUser } from '@/lib/auth';
import { homePathForRole } from '@/lib/roles';

/** Role-aware front door — SRS §2. */
export default async function HomePage() {
  const session = await getSessionUser();
  redirect(session ? homePathForRole(session.role) : '/login');
}
