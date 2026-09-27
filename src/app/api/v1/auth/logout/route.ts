import { withApi } from '@/lib/api';
import { endSession } from '@/lib/auth';

export async function POST(): Promise<Response> {
  return withApi(async () => {
    await endSession();
    return { signedOut: true };
  });
}
