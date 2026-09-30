import Link from 'next/link';
import type { ReactNode } from 'react';

import { EmptyState } from './Feedback';
import styles from './DataTable.module.css';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /**
   * The label used when a row collapses into a card. Defaults to `header` when
   * that is a plain string; a column whose header is an element must supply one,
   * or its card view would show a field with no name.
   */
  cardLabel?: string;
  align?: 'start' | 'end';
  /**
   * Stacks the cell's children instead of running them together.
   *
   * For a cell that carries two facts — `1200` and `0 ออเดอร์` — where one line makes
   * them read as a single number. The primary cell stacks for the same reason and does
   * it implicitly; a column asks for it explicitly, because only the caller knows whether
   * its two children are a figure and its note or something that belongs on one line.
   */
  stack?: boolean;
  width?: string;
  render: (row: T) => ReactNode;
}

/**
 * A table that stops being a table when the screen is narrow.
 *
 * This is the one component every admin screen needed and none of them had, and
 * the reason is that a table on a tablet is unreadable: six columns in 700px
 * either scroll sideways (and hide the columns that matter) or crush into
 * two-word lines. Below the breakpoint each row becomes a card with its column
 * headers as labels, which is the same information in a shape a thumb can read.
 *
 * The card view is done in CSS with `attr(data-label)` rather than by rendering
 * two different trees, so there is exactly one copy of the data in the DOM — two
 * copies is how a screen reader ends up reading every row twice.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  /** Makes a row's first cell a link — a real `<a>`, not a click handler on a `<tr>`. */
  rowHref,
  /** Marks rows that need attention (an order about to expire, a short drawer). */
  highlightRow,
  caption,
  empty,
  summary,
  dense = false,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  highlightRow?: (row: T) => boolean;
  /** Screen-reader description of the table; rendered visually hidden. */
  caption?: string;
  empty?: ReactNode;
  summary?: ReactNode;
  dense?: boolean;
}) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="ยังไม่มีข้อมูล" />}</>;
  }

  return (
    <div className={styles.scroller}>
      <table className={`${styles.table} ${dense ? styles.dense : ''}`}>
        {caption ? <caption className="ln-visually-hidden">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={column.align === 'end' ? styles.alignEnd : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = rowHref?.(row);
            return (
              <tr
                key={getRowKey(row)}
                className={highlightRow?.(row) ? styles.highlight : undefined}
              >
                {columns.map((column, index) => {
                  const label =
                    column.cardLabel ?? (typeof column.header === 'string' ? column.header : '');

                  return (
                    <td
                      key={column.key}
                      data-label={label}
                      className={[
                        column.align === 'end' ? styles.alignEnd : '',
                        column.stack ? styles.stackedCell : '',
                        index === 0 ? styles.primaryCell : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {index === 0 && href ? (
                        <Link href={href} className={styles.rowLink}>
                          {column.render(row)}
                        </Link>
                      ) : (
                        column.render(row)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        {summary ? <tfoot>{summary}</tfoot> : null}
      </table>
    </div>
  );
}

/** A totals row for a money table, so the footer matches the column alignment. */
export function TableSummaryRow({
  columns,
  cells,
}: {
  columns: Column<unknown>[];
  cells: ReactNode[];
}) {
  return (
    <tr>
      {columns.map((column, index) => (
        <td key={column.key} className={column.align === 'end' ? styles.alignEnd : undefined}>
          {cells[index] ?? null}
        </td>
      ))}
    </tr>
  );
}
