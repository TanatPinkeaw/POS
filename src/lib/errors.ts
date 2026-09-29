/**
 * Domain errors.
 *
 * Route handlers catch these and map them onto HTTP status codes in one place,
 * so business rules can be stated once in the domain layer and never leak
 * Prisma-specific exceptions to the client.
 */

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    /**
     * Machine-readable context for the client, added to the error body.
     *
     * A message is for a person; this is for the screen that has to react — the
     * PIN dialog needs to know how many attempts are left, not just that it was
     * refused.
     *
     * Named `context` rather than `details` because `ValidationError` already
     * publishes `details` for its issue list, and that one is deliberately
     * `unknown`: a validation issue is whatever the validator produced.
     */
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * SRS §4.2: a reservation or sale that cannot be satisfied must be rejected with
 * HTTP 409 Conflict rather than silently overselling.
 */
export class InsufficientStockError extends DomainError {
  constructor(
    readonly productId: string,
    readonly requested: number,
    readonly available: number,
    productName?: string,
  ) {
    super(
      `Insufficient stock${productName ? ` for "${productName}"` : ''}: ` +
        `requested ${requested}, available ${available}`,
      'INSUFFICIENT_STOCK',
      409,
    );
  }
}

/** A row was expected to exist and did not. */
export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} not found`, 'NOT_FOUND', 404);
  }
}

/**
 * A state transition or balance invariant did not hold. Reaching this means a
 * guard was bypassed somewhere, so it is a 409 rather than a 500: the request
 * conflicts with the current state of the record.
 */
export class ConflictError extends DomainError {
  constructor(message: string, code = 'CONFLICT') {
    super(message, code, 409);
  }
}

/**
 * A series cannot be allocated from because a device is holding numbers it has not
 * reported yet (ADR 0019).
 *
 * A 409 rather than a 500, and a Thai message rather than an English one: this reaches a
 * counter, and what the person at it needs is what to do next. The machine-readable half
 * is `series`, because a screen may want to say which of the two series is held.
 */
export class SeriesReservedError extends DomainError {
  constructor(readonly series: 'receipt' | 'queue') {
    super(
      'เลขชุดนี้ถูกยืมให้เครื่องที่ยังไม่รายงาน — ต้องซิงค์เครื่องนั้นก่อน หรือให้ผู้ดูแลปิดชุดเลข',
      'SERIES_RESERVED',
      409,
      { series },
    );
  }
}

/** The caller is authenticated but lacks permission. */
export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 'FORBIDDEN', 403);
  }
}

/**
 * A supervisor PIN was wrong, or the PIN is locked.
 *
 * A 403 rather than a 401: the cashier is signed in perfectly well, it is the
 * approval that was refused. The details carry `reason` plus either the attempts
 * remaining or the lock's expiry, because the dialog says something different in
 * each case and guessing on the client would get it wrong.
 */
export class ApprovalRejectedError extends DomainError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, 403, context);
  }
}

/**
 * A caller has spent the attempts they had on a door that needs no session.
 *
 * A 429, and the wait is carried in the body rather than in a `Retry-After`
 * header: every client here already reads the error envelope, and a header would
 * be a second contract for the same fact. `context.retryAfterSeconds` is a number
 * so a screen can count down; the message says it in words for the person holding
 * the phone.
 */
export class RateLimitedError extends DomainError {
  constructor(
    readonly policy: string,
    readonly retryAfterSeconds: number,
  ) {
    super(
      `พยายามหลายครั้งเกินไป — กรุณารออีก ${formatWait(retryAfterSeconds)}`,
      'RATE_LIMITED',
      429,
      { policy, retryAfterSeconds },
    );
  }
}

/**
 * "อีก 3 นาที", "อีก 45 วินาที" — rounded up, because a wait a person is given is
 * never shorter than it turns out to be. A message a user reads is Thai (the rule
 * the whole app follows); the machine-readable half is `retryAfterSeconds`.
 */
function formatWait(seconds: number): string {
  if (seconds >= 60) {
    return `${Math.ceil(seconds / 60)} นาที`;
  }
  return `${Math.max(1, seconds)} วินาที`;
}

/** The caller is not authenticated. */
export class UnauthenticatedError extends DomainError {
  constructor(message = 'Sign in to continue') {
    super(message, 'UNAUTHENTICATED', 401);
  }
}

/** Input failed validation. */
export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message, 'VALIDATION_ERROR', 422);
  }
}
