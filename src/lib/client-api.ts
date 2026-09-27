/**
 * Browser-side API client.
 *
 * Unwraps the `{ data }` / `{ error }` envelope in one place, so a component
 * gets either the payload or a thrown Error carrying the server's own message —
 * which is what makes "สต็อกไม่พอ" surface in the UI as written, rather than as
 * a generic "request failed".
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const body = (await response.json().catch(() => null)) as
    | { data?: T; error?: { message?: string; code?: string } }
    | null;

  if (!response.ok) {
    throw new ApiError(
      body?.error?.message ?? `คำขอไม่สำเร็จ (${response.status})`,
      response.status,
      body?.error?.code ?? 'UNKNOWN',
    );
  }

  return body?.data as T;
}

/** Shorthand for a JSON POST/PATCH. */
export function apiPost<T>(path: string, payload: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(payload) });
}

export function apiPatch<T>(path: string, payload: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(payload) });
}
