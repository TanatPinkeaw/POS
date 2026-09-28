import type { TrendPoint } from '@/lib/chart';
import { axisFor, peak } from '@/lib/chart';
import { formatThbShort } from '@/lib/money';

import styles from './Chart.module.css';

/**
 * A trend, drawn as bars with an optional second series as a line.
 *
 * Written as SVG rather than delegated to a charting library, for three reasons
 * that all come from the same place:
 *
 *   * **It costs no JavaScript.** The chart this replaces shipped a charting
 *     library to the browser and re-rendered the whole canvas on every resize; a
 *     dashboard figure is a picture of data the server already had, so it renders
 *     on the server and ships as markup. It is not a `'use client'` component, and
 *     it must not become one.
 *   * **It is in the design system.** The old chart hardcoded `#3a57e8` and
 *     `#21cc6a` — two colours that were never in the palette, on a chart whose job
 *     is to be read at a glance. These read from tokens, so a rebrand moves them.
 *   * **Bars, not a smoothed area.** A shop's daily takings are discrete sums over
 *     discrete days. A curve implies the sales happened *between* the days, and the
 *     smoothing makes a flat week look like a story.
 *
 * The second series is drawn on its own scale, because baht and order counts are
 * not the same unit and putting them on one axis is how a chart lies: three
 * orders and ฿300 would sit at the same height otherwise.
 *
 * Sizing: the SVG scales with its container, which means the labels scale too.
 * That is the right trade for a screen that is used on a desktop, and the wrong
 * one for a phone — the shop-facing pages are the phone ones, and they do not
 * carry charts.
 */
export function TrendChart({
  points,
  height = 240,
  primaryLabel,
  secondaryLabel,
  formatPrimary = formatThbShort,
}: {
  points: TrendPoint[];
  height?: number;
  /** Legend text for the bars. Omit on a chart with a single series. */
  primaryLabel?: string;
  /** Legend text for the line. Omit when the points carry no `secondary`. */
  secondaryLabel?: string;
  formatPrimary?: (value: number) => string;
}) {
  if (points.length === 0) {
    return <p className={styles.empty}>ยังไม่มีข้อมูลการขายในช่วงนี้</p>;
  }

  const width = 720;
  const padding = { top: 12, right: 14, bottom: 30, left: 58 };
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const { max, ticks } = axisFor(peak(points.map((point) => point.value)));
  const secondary = axisFor(peak(points.map((point) => point.secondary ?? 0)));

  /** Value → y, on whichever series' scale is asked for. */
  const scaleY = (value: number, top: number): number =>
    top <= 0 ? plotBottom : plotBottom - (value / top) * plotHeight;

  const band = plotWidth / points.length;
  const barWidth = Math.min(band * 0.56, 46);

  const linePoints = points
    .map((point, index) => {
      if (point.secondary === undefined) {
        return null;
      }
      const x = plotLeft + band * (index + 0.5);
      return `${x.toFixed(1)},${scaleY(point.secondary, secondary.max).toFixed(1)}`;
    })
    .filter((value): value is string => value !== null);

  const summary = points
    .map((point) => `${point.label} ${formatPrimary(point.value)}`)
    .join(' · ');

  return (
    <div className={styles.wrap}>
      {/*
       * The legend is HTML, not `<text>` inside the SVG. Thai labels have no
       * predictable width, so an in-chart legend either overlaps its neighbour or
       * needs the browser to measure the text — and the browser is right there,
       * laying out a flex row for free.
       */}
      {primaryLabel || secondaryLabel ? (
        <div className={styles.legend}>
          {primaryLabel ? (
            <span className={styles.legendItem}>
              <span className={styles.legendBar} aria-hidden="true" />
              {primaryLabel}
            </span>
          ) : null}
          {secondaryLabel && secondary.max > 0 ? (
            <span className={styles.legendItem}>
              <span className={styles.legendDot} aria-hidden="true" />
              {secondaryLabel}
            </span>
          ) : null}
        </div>
      ) : null}

      <svg
        className={styles.chart}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={primaryLabel ? `${primaryLabel}: ${summary}` : summary}
      >
      {/* Grid and the money axis. The zero line is drawn darker than the rest: it
          is the floor of every bar, and on a chart of a slow week it is the line
          the eye needs to find. */}
      {ticks.map((tick, index) => {
        const y = scaleY(tick, max);
        const baseline = index === 0;
        return (
          <g key={tick}>
            <line
              className={baseline ? styles.baseline : styles.grid}
              x1={plotLeft}
              x2={plotRight}
              y1={y}
              y2={y}
            />
            {max > 0 ? (
              <text className={styles.tick} x={plotLeft - 8} y={y} textAnchor="end" dominantBaseline="middle">
                {formatPrimary(tick)}
              </text>
            ) : null}
          </g>
        );
      })}

      {points.map((point, index) => {
        const centre = plotLeft + band * (index + 0.5);
        const y = scaleY(point.value, max);
        const barHeight = Math.max(plotBottom - y, point.value > 0 ? 2 : 0);

        return (
          <g key={`${point.label}-${index}`}>
            {/* A transparent hit area the full height of the band, so the tooltip
                does not require hitting a two-pixel bar on a quiet day. */}
            <rect
              x={plotLeft + band * index}
              y={plotTop}
              width={band}
              height={plotHeight}
              fill="transparent"
            >
              <title>{point.caption ?? `${point.label}: ${formatPrimary(point.value)}`}</title>
            </rect>
            {barHeight > 0 ? (
              <rect
                className={styles.bar}
                x={centre - barWidth / 2}
                y={plotBottom - barHeight}
                width={barWidth}
                height={barHeight}
                rx={2}
                aria-hidden="true"
              />
            ) : null}
            <text className={styles.axis} x={centre} y={height - 10} textAnchor="middle">
              {point.label}
            </text>
          </g>
        );
      })}

      {secondary.max > 0 && linePoints.length > 1 ? (
        <polyline className={styles.line} points={linePoints.join(' ')} aria-hidden="true" />
      ) : null}

      {secondary.max > 0
        ? points.map((point, index) =>
            point.secondary === undefined ? null : (
              <circle
                className={styles.dot}
                key={`dot-${point.label}-${index}`}
                cx={plotLeft + band * (index + 0.5)}
                cy={scaleY(point.secondary, secondary.max)}
                r={3}
                aria-hidden="true"
              />
            ),
          )
        : null}

      </svg>
    </div>
  );
}
