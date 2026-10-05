import { Icon } from '@/components/ds';

import styles from './CheckoutSteps.module.css';

/**
 * The three circles above the bill at checkout.
 *
 * Display-only, and deliberately not the Pill `Stepper` in `MyOrders`: that one
 * tracks a member's pre-order through four phases on their own phone, while this
 * one tells a queue standing three metres away where the sale in front of them
 * is — being rung up, waiting for a scan, done. Numbered circles joined by
 * connectors rather than chips, because at that distance a filled row of pills
 * reads as one smear and three large shapes read as a position.
 *
 * Completed stages swap their numeral for the set's `check`; the stage the sale
 * is on is marked `aria-current="step"`; stages ahead stay muted. The numerals
 * and the icon are hidden from assistive technology — the adjacent Thai label
 * already announces each stage, and announcing a numeral plus the label is noise.
 */
const STEP_LABELS = ['กำลังคิดเงิน', 'สแกนจ่าย', 'เสร็จแล้ว'] as const;

export function CheckoutSteps({ current }: { current: number }) {
  return (
    <ol className={styles.steps} aria-label="ขั้นตอนการชำระเงิน">
      {STEP_LABELS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            className={`${styles.step} ${done ? styles.done : ''} ${active ? styles.current : ''}`}
            aria-current={active ? 'step' : undefined}
          >
            <span className={styles.circle} aria-hidden="true">
              {done ? <Icon name="check" size={30} strokeWidth={2.5} /> : index + 1}
            </span>
            <span className={styles.label}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
