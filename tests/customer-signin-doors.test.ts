// Seam under test: what the front door *says* when a third-party door did not sign
// anybody in.
//
// Both halves of this were silent in the field. A LINE arrival that failed came back as
// `?line=error` and the screen rendered the door again, unchanged, with no word about what
// had happened; and a Google script that never loaded left an empty white slot with
// nothing to press and nothing to read. Neither is a crash, which is exactly why neither
// was noticed — a screen that says nothing looks like a screen that is still thinking.
//
// The two functions are exported from the component and imported for real, the same way
// `buttonWidthFor` is: a sentence a customer has to act on is behaviour, not markup.
import { describe, expect, it } from 'vitest';

import { googleDoorFailure, lineDoorNotice } from '@/components/shop/CustomerSignIn';

const THAI = /[\u0E00-\u0E7F]/;

describe('the notice the front door shows for a LINE arrival', () => {
  it('explains a binding that arrived without a session, and what to do instead', () => {
    const notice = lineDoorNotice('session');

    expect(notice?.tone).toBe('warning');
    expect(notice?.body).toMatch(THAI);
    // The actionable half: sign in at the counter door, then bind from the account page.
    expect(notice?.body).toContain('เข้าสู่ระบบ');
    expect(notice?.body).toContain('LINE');
  });

  it('names the door a deactivated account has to use', () => {
    const notice = lineDoorNotice('inactive');

    expect(notice?.tone).toBe('danger');
    expect(notice?.body).toMatch(THAI);
    expect(notice?.body).toContain('ติดต่อร้าน');
  });

  it('sends a staff row to the door that works for staff', () => {
    const notice = lineDoorNotice('staff');

    expect(notice?.tone).toBe('danger');
    expect(notice?.body).toMatch(THAI);
    expect(notice?.body).toContain('รหัสผ่าน');
  });

  it('tells an expired or failed consent that pressing again is the move', () => {
    const notice = lineDoorNotice('error');

    expect(notice?.tone).toBe('danger');
    expect(notice?.body).toMatch(THAI);
    expect(notice?.body).toContain('อีกครั้ง');
  });

  it('says nothing about the codes that are not this screen’s business', () => {
    // `claim` is the step below, not a notice; `bound` and `taken` belong to the account
    // page; and an unknown code is a stranger's, not a message.
    for (const result of ['claim', 'bound', 'taken', 'whatever', '', null, undefined]) {
      expect(lineDoorNotice(result), String(result)).toBeNull();
    }
  });
});

describe('what the Google door says when its button never appears', () => {
  it('names the door that does work, in Thai', () => {
    for (const problem of ['script', 'api', 'blank'] as const) {
      const sentence = googleDoorFailure(problem);
      expect(sentence, problem).toMatch(THAI);
      expect(sentence, problem).toContain('เบอร์โทรศัพท์');
    }
  });

  it('distinguishes the three causes, so a field report can be diagnosed', () => {
    // Three different excuses and one identical next step: if the cause were not named,
    // a customer's screenshot would say only "a white box", which is where this started.
    const sentences = new Set([
      googleDoorFailure('script'),
      googleDoorFailure('api'),
      googleDoorFailure('blank'),
    ]);

    expect(sentences.size).toBe(3);
  });

  it('does not blame the customer or claim Google is broken', () => {
    // The generic failure copy would be "เกิดข้อผิดพลาด"; this is not an error the customer
    // caused, and the fix may well be a blocked script on their network.
    expect(googleDoorFailure('blank')).not.toContain('เกิดข้อผิดพลาด');
  });
});
