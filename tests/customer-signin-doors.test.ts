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

import {
  googleDoorFailure,
  googleDoorNotice,
  lineDoorNotice,
  momentaryCodes,
} from '@/components/shop/CustomerSignIn';

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

  it('tells a failed consent that pressing again is the move', () => {
    const notice = lineDoorNotice('error');

    expect(notice?.tone).toBe('danger');
    expect(notice?.body).toMatch(THAI);
    expect(notice?.body).toContain('อีกครั้ง');
  });

  it('says the confirmation expired rather than that the sign-in failed', () => {
    /*
     * The shop's own report: the operator opened the callback address to check it answered,
     * and the front door told them "เข้าสู่ระบบด้วย LINE ไม่สำเร็จ" about a sign-in they had
     * never begun. A state that is missing, tampered with or past its fifteen minutes is not
     * LINE failing — the press can simply be made again — and the two send a customer to
     * different places, so they are two sentences.
     */
    const notice = lineDoorNotice('expired');

    expect(notice?.tone).toBe('warning');
    expect(notice?.body).toMatch(THAI);
    expect(notice?.body).toContain('อีกครั้ง');
    expect(notice?.body).not.toBe(lineDoorNotice('error')?.body);
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

// The redirect landing is the other way a Google arrival can end badly (ADR 0020 §1,
// amended): the browser came back from Google's own page with `?google=` and no session.
// Those codes are the landing's (`google-door.ts`), and this is the seam that decides
// whether the front door says anything about them.
describe('the notice the front door shows for a Google arrival', () => {
  it('names the counter as the next step for a closed account', () => {
    const notice = googleDoorNotice('inactive');

    expect(notice?.tone).toBe('danger');
    expect(notice?.body).toMatch(THAI);
    expect(notice?.body).toContain('ติดต่อร้าน');
  });

  it('tells a failed landing that pressing the button again is the move', () => {
    const notice = googleDoorNotice('error');

    expect(notice?.tone).toBe('danger');
    expect(notice?.body).toMatch(THAI);
    expect(notice?.body).toContain('อีกครั้ง');
  });

  it('says nothing for `new`, which is the phone step rather than a message', () => {
    // The step itself is rendered by the door (`googleResult === 'new'` seeds it), so a
    // sentence here would print the news twice — and the sentence would be about a failure
    // that did not happen.
    expect(googleDoorNotice('new')).toBeNull();
  });

  it('says nothing about a code nobody minted', () => {
    for (const result of ['whatever', '', null, undefined]) {
      expect(googleDoorNotice(result), String(result)).toBeNull();
    }
  });

  it('never prints the LINE door words over a Google failure, or the reverse', () => {
    // The two are read from the same query string by the same page, and a shared vocabulary
    // would be how a customer is told to press a button they did not press.
    expect(googleDoorNotice('error')?.body).not.toContain('LINE');
    expect(lineDoorNotice('error')?.body).not.toContain('Google');
  });
});

// The address a sentence leaves behind (ADR 0030 §6, amended). A notice reports a walk that
// has ended; left in the query string, every re-open — the back button, a bookmark, a link
// pasted into a chat, the shop's operator checking the page answers — re-reads a failure that
// is over. The step codes are the opposite: they render a form seeded from the first paint,
// and a customer who reloads mid-flow must land back in it rather than at the button.
describe('which arrival codes the front door keeps in its address', () => {
  it('lets go of a sentence', () => {
    expect(momentaryCodes({ line: 'error' })).toEqual(['line']);
    expect(momentaryCodes({ line: 'expired' })).toEqual(['line']);
    expect(momentaryCodes({ google: 'error' })).toEqual(['google']);
    expect(momentaryCodes({ line: 'inactive', google: 'inactive' })).toEqual(['line', 'google']);
  });

  it('keeps a step, because that address is the customer’s own', () => {
    expect(momentaryCodes({ line: 'claim' })).toEqual([]);
    expect(momentaryCodes({ google: 'new' })).toEqual([]);
    expect(momentaryCodes({ line: 'claim', google: 'new' })).toEqual([]);
  });

  it('keeps both when one is a step and the other is a sentence', () => {
    // The reachable mix: a Google first sign-in waiting on a phone, arriving beside a stale
    // LINE word from a walk that failed earlier in the same tab.
    expect(momentaryCodes({ line: 'error', google: 'new' })).toEqual(['line']);
    expect(momentaryCodes({ line: 'claim', google: 'error' })).toEqual(['google']);
  });

  it('has nothing to say about a code nobody minted, or about no code at all', () => {
    for (const result of ['whatever', '', null, undefined]) {
      expect(momentaryCodes({ line: result }), String(result)).toEqual([]);
      expect(momentaryCodes({ google: result }), String(result)).toEqual([]);
    }
    expect(momentaryCodes({})).toEqual([]);
  });
});
