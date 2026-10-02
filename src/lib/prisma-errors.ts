/**
 * Reading Prisma's failures as what they mean.
 *
 * One classifier rather than one per caller, because the failure it recognises is the
 * *success* case of half this codebase: a unique index is how a duplicate write is refused,
 * and "somebody already wrote this" is a fact callers act on rather than an error they
 * report. `number-blocks.ts` uses it to turn a second borrow into "somebody already holds
 * this range"; `offline-sales.ts` uses it to turn a retried bill into the bill that is
 * already recorded.
 *
 * Read without importing Prisma's error classes, deliberately — the code is the contract
 * that survives a client upgrade, and the two shapes below are what a rejected row looks
 * like through Prisma.
 */

/**
 * Whether a write was refused because something of that shape already exists.
 *
 * Two codes rather than one because the two indexes in this schema are reached
 * differently. A unique constraint Prisma knows about from the schema reports `P2002`. A
 * **partial** unique index — which Prisma cannot express in `schema.prisma` and therefore
 * does not know about — arrives as a generic raw-query failure (`P2010`) whose underlying
 * PostgreSQL code is `23505`, so it has to be judged by what the database said.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; meta?: { code?: string; message?: string } };
  if (candidate.code === 'P2002') {
    return true;
  }
  if (candidate.code === 'P2010') {
    const meta = candidate.meta;
    return (
      meta?.code === '23505' || (typeof meta?.message === 'string' && meta.message.includes('23505'))
    );
  }
  return false;
}
