/**
 * The design system.
 *
 * Screens import from here (`import { Button, Card } from '@/components/ds'`)
 * rather than reaching into individual files, so that a component can be split,
 * renamed, or given a new implementation without touching twenty imports.
 *
 * This is what replaces `@/components/hope/ui` and, eventually, Bootstrap: the
 * plan is that no screen imports a Bootstrap class name or the Hope UI primitives
 * once it has been migrated, and `npm run ui:audit` is what keeps that true.
 */
export { Button, LinkButton } from './Button';
export { Card, CardGrid, PageHeader } from './Card';
export { DataTable, TableSummaryRow, type Column } from './DataTable';
export { EmptyState, InlineNotice, Skeleton, SkeletonRows, Spinner } from './Feedback';
export { FieldRow, FieldShell, SelectField, TextAreaField, TextField, ToggleField } from './Field';
export { Icon } from './Icon';
export { ICON_NAMES, ICON_PATHS, type IconName } from './icons';
export {
  Avatar,
  Breadcrumb,
  Pagination,
  SearchField,
  SplitPane,
  Stack,
  Toolbar,
} from './Layout';
export { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';
export { Numpad, QuickCash } from './Numpad';
export { ConfirmDialog, Overlay } from './Overlay';
export { Tabs, type TabItem } from './Tabs';
export { ToastProvider, useToast, type ToastTone } from './Toast';
export { CategoryChip, KpiStat, Money, Pill, Stat, StatusDot, StatusPill } from './Value';
