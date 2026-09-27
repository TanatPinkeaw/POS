/**
 * Small presentational primitives over Hope UI's class names.
 *
 * These exist so screen code reads as intent ("StatCard") rather than as a wall
 * of Bootstrap utility classes, and so a Hope UI class change lands in one file
 * instead of twenty.
 */
import type { ReactNode } from 'react';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header d-flex justify-content-between align-items-center">
          <div>
            {title && <h5 className="card-title mb-0">{title}</h5>}
            {subtitle && <p className="text-muted mb-0 small">{subtitle}</p>}
          </div>
          {actions && <div className="d-flex gap-2">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${bodyClassName}`}>{children}</div>
    </div>
  );
}

/** Headline figure with a caption, the shape Hope UI uses across its dashboards. */
export function StatCard({
  label,
  value,
  hint,
  tone = 'primary',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'info';
  icon?: ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-start">
          <div>
            <span className="text-muted small d-block mb-1">{label}</span>
            <h3 className="mb-0 pos-numeric">{value}</h3>
            {hint && <span className="text-muted small">{hint}</span>}
          </div>
          {icon && (
            <div className={`bg-soft-${tone} rounded p-2 text-${tone}`}>
              {icon}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Badge({
  children,
  tone = 'secondary',
  soft = true,
  className = '',
}: {
  children: ReactNode;
  tone?: 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info' | 'dark';
  soft?: boolean;
  className?: string;
}) {
  return (
    <span className={`badge ${soft ? `bg-soft-${tone} text-${tone}` : `bg-${tone}`} ${className}`}>
      {children}
    </span>
  );
}

export function Spinner({ label = 'กำลังโหลด…' }: { label?: string }) {
  return (
    <div className="d-flex align-items-center gap-2 text-muted py-4">
      <span className="spinner-border spinner-border-sm" role="status" aria-hidden="true" />
      <span className="small">{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-5">
      <h5 className="mb-1">{title}</h5>
      {description && <p className="text-muted mb-3 small">{description}</p>}
      {action}
    </div>
  );
}

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'info';
  children: ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`} role="alert">
      {children}
    </div>
  );
}

/** Renders a THB amount in the tabular-figure style used across the app. */
export function Money({
  amount,
  className = '',
}: {
  amount: number;
  className?: string;
}) {
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));

  return (
    <span className={`pos-numeric ${className}`}>
      {amount < 0 ? '-' : ''}฿{formatted}
    </span>
  );
}
