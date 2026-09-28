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
    /**
     * Structured detail the screen has to react to, when the server sent any.
     *
     * The supervisor PIN dialog is the reason this exists: "wrong PIN" and "locked
     * for five minutes" are different situations with different next steps, and
     * the server is the only side that knows which one happened.
     */
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Envelope<T> {
  data?: T;
  error?: {
    message?: string;
    code?: string;
    issues?: { path: string; message: string }[];
    [key: string]: unknown;
  };
}

/** Turns a response into a payload, or throws the server's own message. */
async function readEnvelope<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as Envelope<T> | null;

  if (!response.ok) {
    // A zod failure lists which field was wrong; joining them onto the message
    // means a form can show one actionable line without special-casing 422s.
    const issues = body?.error?.issues?.map((issue) => issue.message).filter(Boolean) ?? [];
    const message =
      issues.length > 0
        ? issues.join(' · ')
        : (body?.error?.message ?? `คำขอไม่สำเร็จ (${response.status})`);

    const code = body?.error?.code ?? 'UNKNOWN';
    /*
     * Everything the error body carries that is not one of the three fields this
     * helper already names is context. Spreading the body itself would put
     * `message` and `code` in there twice.
     */
    const { message: _message, code: _code, issues: _issues, ...context } = body?.error ?? {};

    throw new ApiError(message, response.status, code, context);
  }

  return body?.data as T;
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

  return readEnvelope<T>(response);
}

/** Shorthand for a JSON POST/PATCH/PUT. */
export function apiPost<T>(path: string, payload: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(payload) });
}

export function apiPatch<T>(path: string, payload: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(payload) });
}

export function apiPut<T>(path: string, payload: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PUT', body: JSON.stringify(payload) });
}

/**
 * A multipart upload.
 *
 * Deliberately not `apiFetch` with a `FormData` body: that helper attaches a JSON
 * content type whenever a body is present, and forcing `application/json` onto a
 * multipart body removes the boundary the browser generated — the server then
 * sees no fields at all, and the failure looks like "no file attached".
 */
export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    body: formData,
    credentials: 'same-origin',
  });

  return readEnvelope<T>(response);
}

/**
 * Downloads a binary response as a file.
 *
 * The download is fetched rather than navigated to so that a refusal — 403 for
 * the wrong role, 422 for a bad range — surfaces as a message beside the button
 * instead of replacing the screen with raw JSON.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(path, { credentials: 'same-origin' });

  if (!response.ok) {
    await readEnvelope<never>(response); // throws with the server's message
    throw new ApiError('ดาวน์โหลดไม่สำเร็จ', response.status, 'UNKNOWN');
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const filename = match?.[1] ?? fallbackName;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
