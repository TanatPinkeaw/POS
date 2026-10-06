/**
 * What a field points `aria-describedby` at.
 *
 * A control's description is only as good as the ids that exist on the page, and the one
 * case that can be wrong is a field carrying both a help line and an error: `FieldShell`
 * *replaces* the help paragraph with the failure rather than stacking two paragraphs of
 * small print under one input, so the help node is not on the page while an error is. A
 * description naming a node that was removed is a sentence a screen reader has nothing to
 * read — found on the shop-logo field of `/admin/settings`, where a refused link left
 * `aria-describedby="shop-logo-help shop-logo-error"` and only the second id existed.
 */
import { describe, expect, it } from 'vitest';

import { describedBy } from '@/components/ds/Field';

describe('describedBy', () => {
  it('names the help line when that is all the field has', () => {
    expect(describedBy('shop-logo', 'วางลิงก์รูป')).toBe('shop-logo-help');
  });

  it('names the failure when that is all the field has', () => {
    expect(describedBy('shop-logo', undefined, 'เปิดรูปไม่ได้')).toBe('shop-logo-error');
  });

  it('names only the failure when a field has both, because the help is not on the page', () => {
    expect(describedBy('shop-logo', 'วางลิงก์รูป', 'เปิดรูปไม่ได้')).toBe('shop-logo-error');
  });

  it('names nothing when the field has neither', () => {
    expect(describedBy('shop-logo')).toBeUndefined();
  });
});
