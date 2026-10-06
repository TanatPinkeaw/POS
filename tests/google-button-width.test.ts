import { describe, expect, it } from 'vitest';

import { buttonWidthFor } from '@/components/shop/CustomerSignIn';

/*
 * The width handed to Google's `renderButton` is measured from the slot it sits
 * in, and Google accepts 200–400 for a large standard button — outside that
 * band it refuses to render, or overflows its own frame. The failure this
 * guards: a width fixed in code (320) overflowed the card by 37 px on the phone
 * the shop supports (a 283 px slot on an iPhone 7 Plus, ADR 0031) and missed
 * the slot's centreline on every screen wider than the card, because Google
 * places the iframe at the slot's left edge and never measures again.
 */
describe('buttonWidthFor', () => {
  it('takes the slot width it is given, floored to a whole pixel', () => {
    expect(buttonWidthFor(283)).toBe(283);
    expect(buttonWidthFor(283.9)).toBe(283);
  });

  it('clamps a narrow slot to the floor Google will still render', () => {
    expect(buttonWidthFor(180)).toBe(200);
    expect(buttonWidthFor(0)).toBe(200);
  });

  it('clamps a wide slot to the ceiling, so a full-width desktop pane cannot overflow', () => {
    expect(buttonWidthFor(500)).toBe(400);
    expect(buttonWidthFor(1200)).toBe(400);
  });

  it('returns the exact width inside the band Google accepts', () => {
    expect(buttonWidthFor(320)).toBe(320);
    expect(buttonWidthFor(200)).toBe(200);
    expect(buttonWidthFor(400)).toBe(400);
  });
});
