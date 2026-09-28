'use client';

/**
 * The document buttons one order row offers.
 *
 * A row in the back office is where a shop actually deals with a customer
 * complaint — the paper receipt is in somebody's hand, and the manager is looking
 * it up. So the buttons answer the three questions that come up, in the order
 * they come up:
 *
 *   * **completed** — the receipt (a copy), and a refund (the reversal).
 *   * **refunded** — the receipt *and* the credit note, because the pair is what
 *     an accountant asks for and the second is no use without the first.
 *   * anything else — nothing. Offering a document that does not exist yet is a
 *     promise the row cannot keep.
 *
 * Which of the three is available comes from the order's status, not from a flag
 * the caller passes: `refunded` is terminal, so the refund button simply is not
 * rendered for it, and the server would refuse it anyway.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ds';
import { RefundDialog } from '@/components/pos/RefundDialog';

import { CreditNoteReprintButton } from './CreditNoteReprintButton';
import { ReceiptReprintButton } from './ReceiptReprintButton';

export function OrderActions({
  orderId,
  orderNumber,
  status,
  amountThb,
  lineCount,
}: {
  orderId: string;
  orderNumber: string;
  status: string;
  amountThb: number;
  lineCount: number;
}) {
  const router = useRouter();
  const [refunding, setRefunding] = useState(false);

  const showsReceipt = status === 'completed' || status === 'refunded';

  return (
    <>
      {showsReceipt ? (
        <ReceiptReprintButton orderId={orderId} orderNumber={orderNumber} />
      ) : null}

      {status === 'refunded' ? (
        <CreditNoteReprintButton orderId={orderId} orderNumber={orderNumber} />
      ) : null}

      {status === 'completed' ? (
        <Button variant="secondary" size="sm" onClick={() => setRefunding(true)}>
          คืนเงิน
        </Button>
      ) : null}

      {refunding ? (
        <RefundDialog
          target={{ orderId, orderNumber, amountThb, lineCount }}
          onClose={() => setRefunding(false)}
          onRefunded={() => {
            setRefunding(false);
            /*
             * The row behind this dialog is server-rendered, and its status has
             * just changed underneath it — from `completed` to `refunded`, with a
             * different set of buttons and a different pill. Refreshing is how a
             * server component is told to re-read; the alternatives are a stale
             * row that still offers a refund, or a page reload that loses the
             * manager's place.
             */
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
