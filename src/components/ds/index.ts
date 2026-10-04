/**
 * The design system.
 *
 * Screens import from here (`import { Button, Card } from '@/components/ds'`)
 * rather than reaching into individual files, so that a component can be split,
 * renamed, or given a new implementation without touching twenty imports.
 *
 * This replaced `@/components/hope/ui`, which is now deleted: every screen
 * imports from here, and nothing imports the Hope UI primitives any more. The
 * Bootstrap class names and the vendored stylesheets that outlived that module
 * are gone as well, and `npm run ui:audit` is what keeps them from coming back.
 */
export { Button, LinkButton } from './Button';
export { Card, CardGrid, PageHeader } from './Card';
export { TrendChart } from './Chart';
export { DataTable, TableSummaryRow, type Column } from './DataTable';
export { EmptyState, InlineNotice, Loader, Skeleton, SkeletonRows, Spinner } from './Feedback';
export { FieldRow, FieldShell, SelectField, TextAreaField, TextField, ToggleField } from './Field';
export { FileField } from './FileField';
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
export { PinPad } from './PinPad';
export { QrCode } from './QrCode';
export { QrPanel } from './QrPanel';
export { ConfirmDialog, Overlay } from './Overlay';
export { Tabs, type TabItem } from './Tabs';
export { Thumb, type ThumbSize } from './Thumb';
export { ToastProvider, useToast, type ToastTone } from './Toast';
export { CategoryChip, KpiStat, Money, Pill, Stat, StatusDot, StatusPill } from './Value';
