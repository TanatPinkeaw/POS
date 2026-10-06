# The เหลี่ยมนอก brand — concept and rules

The single source of the name, tagline, pronunciation and palette is
`src/brand/brand.ts`. This file is why those choices are what they are, written
down so the next screen does not have to rediscover them — and so the concept
the owner asked to keep survives every round of UI work.

## The concept

The name answers **วงใน** (WongNai) — *the in-crowd*, the circle a shop is
either inside or outside of. **เหลี่ยมนอก** (Liam Nong, *the square outside*)
is the square that stands outside that circle: outside the frame, and square
about it. That is the whole concept, and it is what the tagline says in both
languages:

> ระบบขายหน้าร้านสำหรับร้านที่ไม่ได้อยู่ในกรอบ · Point of sale for shops that
> do not fit the mould

Everything the brand does downstream is this one idea.

## What carries it in the product

- **The name and tagline** render on the platform surfaces only — `/login`,
  the error and 404 pages, the sidebar, the browser title. `BRAND_SURFACES`
  in `brand.ts` is the switch. The rule is absolute: the เหลี่ยมนอก name
  **never** appears on a receipt, a customer page, or anything a shop's own
  customer reads — those surfaces belong to the renter's shop, not to the
  platform.
- **The edges.** Radius tokens are 3/4/6px (`--ln-radius-*`), deliberately
  sharp — the rounded look is the vocabulary this brand replaced, and the
  comment on the token is where that decision lives. Circles appear only where
  the shape itself carries meaning (a step dot, a chart point), never as
  decoration.
- **The mark** is the supplied artwork (`public/brand-mark.png`, ADR 0015) —
  a picture, not a concept diagram. The name is copy and the mark is a
  picture; they say different things on purpose. The wordmark lockup that
  pairs them lives in one place (`src/brand/BrandMark.tsx`).

## The rules for new UI work

1. Radius comes from `--ln-radius-*`, never a literal. A screen that wants
   "softer" corners is wrong for the brand, not a taste question.
2. Brand copy stays in the outsider voice — plain, a little proud of not
   fitting. No corporate filler on platform surfaces.
3. The brand name reaches only `BRAND_SURFACES.platform` screens. If a screen
   is tenant-owned, it carries the shop's identity and no เหลี่ยมนอก.
4. The name, tagline, pronunciation and palette are typed once in `brand.ts`.
   A screen that spells the brand name inline is a bug — fix it by reading
   `BRAND`.
