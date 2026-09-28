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
