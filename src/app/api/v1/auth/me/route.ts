import { withApi } from '@/lib/api';
import { requireActiveUser } from '@/lib/auth';

export async function GET(): Promise<Response> {
  return withApi(async () => {
    const { user } = await requireActiveUser();
    return {
      id: user.id,
      role: user.role,
      fullName: user.full_name,
      phone: user.phone,
      pointsBalance: user.points_balance,
    };
  });
}
