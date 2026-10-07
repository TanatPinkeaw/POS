// Seam under test: the script an operator runs to put a Google client id into the
// running process, and the read-back that tells them whether it worked.
//
// Found by reading it against the deployment: this script — the only instrument the
// owner has for "did the value reach the process, or is it just on disk?" — probed
// `/shop`, which stopped being the sign-in screen when the doors swapped (ADR 0029).
// `/shop` now answers 307, so the readiness loop never saw a 200 and exited 1 with
// "did not answer 200 on :3000 within 30s" on a service that was serving perfectly, and
// the read-back fetched the redirect's empty body: the two failure modes it exists to
// tell apart became one indistinguishable shrug. A deployment tool that reports a
// phantom outage is worse than no tool, because it sends the next round hunting the
// wrong thing — which is exactly what it did.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const script = (): string => readFileSync('deploy/set-google-client-id.sh', 'utf8');

describe('the Google client-id deploy script', () => {
  it('waits for the screen that renders the Google door, not a redirect to it', () => {
    const source = script();

    expect(source).toContain('http://127.0.0.1:${PORT}/login');
    expect(source).not.toContain('http://127.0.0.1:${PORT}/shop');
  });

  it('reads the served page back and tells the two failures apart', () => {
    const source = script();

    // "Configured and served" against "configured on disk but not in the process" are the
    // two states that look identical from a browser, so both strings have to stay.
    expect(source).toContain('apps.googleusercontent.com');
    expect(source).toContain('ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google');
  });

  it('sends the operator to the front door when it is done', () => {
    expect(script()).toContain('${PUBLIC_URL%/}/login');
  });
});
