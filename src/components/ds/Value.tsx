import type { ReactNode } from 'react';

import { formatThb } from '@/lib/money';
import { categoryColorKey } from '@/lib/palette';

import { Icon } from './Icon';
import type { IconName } from './icons';
import styles from './Value.module.css';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

/**
 * A THB amount.
 *
 * Negative amounts are coloured and signed, because in this app a negative is
 * never a formatting detail: it is a refund, a shortfall in the drawer, or a
 * loss on a line, and the whole point of looking at it is to notice.
 *
 * `formatThb` is hand-rolled in `src/lib/money.ts` rather than using
 * `Intl.NumberFormat`: the glyphs and grouping must not depend on which ICU data
 * the host Node build happens to carry.
 */
export function Money({
  amount,
  tone,
  signed = false,
  size = 'md',
  className,
}: {
  amount: number;
  tone?: Tone;
  /** Forces a leading `+` on positive amounts, for deltas. */
  signed?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const resolved = tone ?? (amount < 0 ? 'danger' : 'neutral');
  const text = `${signed && amount > 0 ? '+' : ''}${formatThb(Math.abs(amount))}`;
  const withSign = amount < 0 ? `-${text}` : text;

  return (
    <span
      className={`${styles.money} ${styles[`size_${size}`]} ${styles[`tone_${resolved}`]} ${className ?? ''}`}
    >
      {withSign}
    </span>
  );
}

/** A headline figure with a label — the shape every dashboard is built from. */
export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: IconName;
}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statText}>
        <p className={styles.statLabel}>{label}</p>
        <p className={styles.statValue}>{value}</p>
        {hint ? <p className={styles.statHint}>{hint}</p> : null}
      </div>
      {icon ? (
        <span className={`${styles.statIcon} ${styles[`tone_${tone}`]}`} aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
      ) : null}
    </div>
  );
}

/**
 * A short status label.
 *
 * `solid` is for the one thing on a screen that must be unmissable (an order
 * that is about to expire); everything else is soft, because a board with twelve
 * saturated badges communicates nothing.
 */
export function Pill({
  children,
  tone = 'neutral',
  solid = false,
  icon,
}: {
  children: ReactNode;
  tone?: Tone;
  solid?: boolean;
  icon?: IconName;
}) {
  return (
    <span className={`${styles.pill} ${solid ? styles[`pillSolid_${tone}`] : styles[`pillSoft_${tone}`]}`}>
      {icon ? <Icon name={icon} size={14} strokeWidth={2} /> : null}
      {children}
    </span>
  );
}

/**
 * Maps this application's enums to a tone, in one place.
 *
 * Without this every screen invents its own colour for `ready_for_pickup`, and
 * two screens end up disagreeing about whether "ready" is blue or green.
 */
const STATUS_TONE: Record<string, Tone> = {
  pending: 'warning',
  confirmed: 'info',
  ready_for_pickup: 'success',
  completed: 'neutral',
  cancelled: 'danger',
  // Amber rather than red: a refund is a deliberate, documented reversal with a
  // credit note behind it, not a failure — but it is money leaving the till and
  // should not read as an ordinary closed sale either.
  refunded: 'warning',
  open: 'success',
  closed: 'neutral',
  balanced: 'success',
  short: 'danger',
  over: 'warning',
  pos_walkin: 'neutral',
  preorder: 'brand',
};

export function StatusPill({ status, label }: { status: string; label: string }) {
  return <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{label}</Pill>;
}

/**
 * The same status, expressed as the colour-coded dot a till screen uses.
 *
 * The reference design communicates an order's state by colour so that an
 * operator can take in a whole column of orders without reading any of them. A
 * dot beside a label is how that is done here: it works in a 200px sidebar row,
 * it survives being printed in greyscale as a shape, and the label keeps the
 * meaning available to a screen reader and to anyone who cannot separate the red
 * from the green.
 */
export function StatusDot({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return (
    <span className={styles.dotLabel}>
      <span className={`${styles.dot} ${styles[`dotFill_${tone}`]}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * An aisle's colour, derived from the category rather than stored on it.
 *
 * A shop that bulk-imported two hundred categories gets distinguishable aisles
 * without entering a colour for each, and the colour is stable — the same
 * category wears the same colour on the till, in the back office, and in an
 * exported report, because the mapping is a pure function of the id (see
 * `categoryColorKey`).
 *
 * The hue is carried by a CSS variable so that the text and its tint are the same
 * colour by construction, in both schemes, without the component knowing which
 * scheme it is rendering into.
 */
export function CategoryChip({
  categoryId,
  name,
}: {
  categoryId: number | null | undefined;
  name: string;
}) {
  const key = categoryColorKey(categoryId);
  return (
    <span className={styles.category} data-cat={key}>
      {name}
    </span>
  );
}

/**
 * A figure with a change against a previous period.
 *
 * `delta` is rendered with an explicit sign and an arrow, never colour alone: on
 * the dashboard the person reading it is often the shop owner on a phone in
 * daylight, and "up 12% in red because returns rose" is exactly the case where
 * colour without a sign tells the wrong story.
 */
export function KpiStat({
  label,
  value,
  delta,
  deltaLabel,
  tone = 'neutral',
}: {
  label: ReactNode;
  value: ReactNode;
  /** Percentage change; positive is up. Omit when there is no baseline. */
  delta?: number;
  deltaLabel?: string;
  tone?: Tone;
}) {
  const up = (delta ?? 0) > 0;
  const flat = delta === 0 || delta === undefined;

  return (
    <div className={styles.stat}>
      <div className={styles.statText}>
        <p className={styles.statLabel}>{label}</p>
        <p className={styles.statValue}>{value}</p>
        {!flat ? (
          <p className={`${styles.statDelta} ${styles[`tone_${up ? 'success' : 'danger'}`]}`}>
            <Icon name={up ? 'trendUp' : 'trendDown'} size={14} />
            <span>
              {up ? '+' : ''}
              {delta!.toFixed(1)}%{deltaLabel ? <span className={styles.statHint}> {deltaLabel}</span> : null}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
