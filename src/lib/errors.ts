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
    /**
     * The same failure written in English, for the server log only.
     *
     * `message` goes to the client, and this app talks to a Thai shop counter: the
     * person reading it is an employee standing in front of a customer, so it has to
     * be a sentence they can read aloud. That is a real constraint on an error class,
     * because it used to be `NotFoundError` that appended the English — it took a
     * noun and built `` `${what} not found` ``, so every one of its forty-nine call
     * sites shipped English no matter what noun it was handed, and no amount of care
     * at the call site could prevent it.
     *
     * So the sentence is the caller's to write, in the shop's language, and this is
     * where the debugging half goes instead: the ids and quantities that make the log
     * line worth having, kept out of the response so a customer-facing surface cannot
     * leak them. `errorResponse` writes it to the console whenever it is present.
     */
    readonly detail?: string,
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

/**
 * A row was expected to exist and did not.
 *
 * Takes the sentence to show rather than composing one. Every caller of this used to
 * hand over an English noun and get English back, which is why "No order is waiting
 * for collection with those details not found" reached a cashier in the middle of a
 * handover: a trailing "not found" stuck onto a sentence that had already finished.
 *
 * The second argument is the English line for the log, and is worth passing whenever
 * there is an id worth recording — the whole reason this error is hard to debug from
 * a 404 alone is that the 404 cannot say which row it wanted.
 */
export class NotFoundError extends DomainError {
  constructor(message: string, detail?: string) {
    super(message, 'NOT_FOUND', 404, undefined, detail);
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

/**
 * The caller is authenticated but lacks permission.
 *
 * Takes an optional English line for the log, for the same reason `NotFoundError`
 * does: the sentence a screen shows cannot carry the two identifiers whose mismatch
 * caused the refusal, so the log is where that pair has to live.
 */
export class ForbiddenError extends DomainError {
  constructor(message = 'คุณไม่มีสิทธิ์ทำรายการนี้', detail?: string) {
    super(message, 'FORBIDDEN', 403, undefined, detail);
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
  constructor(message = 'กรุณาเข้าสู่ระบบก่อน', detail?: string) {
    super(message, 'UNAUTHENTICATED', 401, undefined, detail);
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
