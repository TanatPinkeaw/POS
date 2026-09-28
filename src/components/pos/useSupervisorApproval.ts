'use client';

import { useCallback, useRef, useState } from 'react';

import type { SupervisorAction } from '@/lib/supervisor-view';

import type { ApprovalGrant } from './SupervisorApprovalDialog';

export interface ApprovalRequest {
  action: SupervisorAction;
  /** The value the approval is bound to. Must be what the retry sends. */
  targetId: string;
  /** What the operator is being asked about, in their own words. */
  summary?: string;
}

export interface PendingApproval extends ApprovalRequest {
  /** Resolves the request; null means the supervisor walked away. */
  settle: (grant: ApprovalGrant | null) => void;
}

/**
 * Turns a refused action into a prompt, and a PIN into a token.
 *
 * Promise-shaped rather than callback-shaped on purpose: the call site reads
 *
 *     const token = await approval.request({ … });
 *     if (!token) return;
 *     await apiFetch(path, { method: 'POST', headers: { 'x-supervisor-token': token } });
 *
 * which is the whole flow in three lines and cannot drift out of order. The
 * alternative — a boolean this hook exports and the call site polls — is how a
 * gated action ends up retrying before anybody has approved it.
 *
 * One request at a time: a second `request` while the first is open would leave
 * the first promise unresolved forever, so the second one resolves the first as
 * a refusal. On a till only one gated action can be on screen anyway.
 */
export function useSupervisorApproval(): {
  pending: PendingApproval | null;
  request: (request: ApprovalRequest) => Promise<string | null>;
} {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const settleRef = useRef<((grant: ApprovalGrant | null) => void) | null>(null);

  const request = useCallback((next: ApprovalRequest): Promise<string | null> => {
    // Any earlier request is abandoned rather than left hanging.
    settleRef.current?.(null);

    return new Promise<string | null>((resolve) => {
      settleRef.current = (grant) => {
        settleRef.current = null;
        setPending(null);
        resolve(grant?.token ?? null);
      };
      setPending({ ...next, settle: (grant) => settleRef.current?.(grant) });
    });
  }, []);

  return { pending, request };
}
