/**
 * Route-handler plumbing.
 *
 * Every handler funnels through `withApi`, so the mapping from domain error to
 * HTTP status is stated exactly once and no handler has to remember that
 * insufficient stock is a 409.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { DomainError, ValidationError } from './errors';

/** Successful response envelope. */
export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

/** Error response envelope. */
export function fail(
  message: string,
  code: string,
  status: number,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: { message, code, ...extra } }, { status });
}

/**
 * Translates anything thrown inside a handler into a response.
 *
 * Unknown errors are logged and flattened to a 500 whose body carries no
 * internals, so a Prisma message never reaches the client.
 */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof DomainError) {
    return fail(error.message, error.code, error.httpStatus);
  }

  if (error instanceof ZodError) {
    return fail('Request body failed validation', 'VALIDATION_ERROR', 422, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  console.error('[api] unhandled error', error);
  return fail('Something went wrong on our side', 'INTERNAL_ERROR', 500);
}

/** Runs a handler body, normalising success and failure. */
export async function withApi<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    return ok(await fn());
  } catch (error) {
    return errorResponse(error);
  }
}

/** Parses and validates a JSON request body. */
export async function readJson<T>(
  request: Request,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  return schema.parse(payload);
}
