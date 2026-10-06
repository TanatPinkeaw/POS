/**
 * The icon set.
 *
 * Hand-written rather than pulled from a package, for the reasons this codebase
 * keeps applying: it must render offline, it must not add a dependency for
 * twenty-four shapes, and the previous arrangement — text glyphs like `☰`, `☾`,
 * and a scattering of emoji — rendered differently on Windows, iOS and Android,
 * which is exactly the kind of drift a design system exists to remove.
 *
 * Every icon is a single `d` on a 24×24 grid, drawn as strokes with round caps so
 * they line up optically with each other at any size. Circles are written as the
 * two-arc idiom (`m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0`) rather than as a
 * `<circle>`, which keeps one icon one path and lets the whole set be one map of
 * strings.
 *
 * Add to this file as screens need them, and keep the geometry to whole and half
 * units — a 0.5 offset here is what makes a set look hand-drawn.
 */
export const ICON_PATHS = {
  dashboard: 'M4 4 H10 V10 H4 Z M14 4 H20 V10 H14 Z M4 14 H10 V20 H4 Z M14 14 H20 V20 H14 Z',
  box: 'M3.5 7.5 L12 3 L20.5 7.5 V16.5 L12 21 L3.5 16.5 Z M3.5 7.5 L12 12 L20.5 7.5 M12 12 V21',
  cart: 'M3 4 H5.5 L7.5 15 H18.5 L20.5 7 H6 M9.5 19 m-1.5 0 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0 M17.5 19 m-1.5 0 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0',
  receipt: 'M6 3 H18 V21 L15 19 L12 21 L9 19 L6 21 Z M9 8 H15 M9 12 H15 M9 15.5 H13',
  users:
    'M8.5 11.5 m-3.5 0 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0 M2.5 20.5 c0 -3.6 2.6 -6 6 -6 s6 2.4 6 6 M16 5.4 a3 3 0 1 1 0 6 M15.5 14.6 c2.9 0.3 5 2.5 5 5.9',
  calendar: 'M4 5.5 H20 V20 H4 Z M4 10 H20 M8 3 V7 M16 3 V7',
  clock: 'M12 12 m-8.5 0 a8.5 8.5 0 1 0 17 0 a8.5 8.5 0 1 0 -17 0 M12 7 V12.5 L16 15',
  chart: 'M4 20 H20 M7.5 20 V13 M12 20 V7 M16.5 20 V15.5',
  sliders: 'M5 7 H19 M5 12 H19 M5 17 H19 M9 5 V9 M15 10 V14 M7 15 V19',
  tag: 'M3 11.5 V4 H10.5 L20.5 12.5 L12.5 20.5 Z M7 7.5 m-0.9 0 a0.9 0.9 0 1 0 1.8 0 a0.9 0.9 0 1 0 -1.8 0',
  upload: 'M12 16.5 V4 M7.5 8.5 L12 4 L16.5 8.5 M4 20 H20',
  download: 'M12 4 V16.5 M7.5 12 L12 16.5 L16.5 12 M4 20 H20',
  print: 'M7 8 V3.5 H17 V8 M7 18 H4 V10 H20 V18 H17 M7 14 H17 V21 H7 Z',
  search: 'M11 11 m-6.5 0 a6.5 6.5 0 1 0 13 0 a6.5 6.5 0 1 0 -13 0 M15.8 15.8 L20.5 20.5',
  scan: 'M4 5 V19 M7.5 5 V19 M11 5 V14 M14.5 5 V19 M17.5 5 V19 M20.5 5 V19',
  plus: 'M12 5 V19 M5 12 H19',
  minus: 'M5 12 H19',
  trash: 'M4 7 H20 M9 7 V4 H15 V7 M6.5 7 L8 20.5 H16 L17.5 7 M10 11 V17 M14 11 V17',
  edit: 'M4 20 V15.5 L15.5 4 L20 8.5 L8.5 20 Z M13 6.5 L17.5 11',
  check: 'M5 12.5 L10 17.5 L19.5 6.5',
  close: 'M6 6 L18 18 M18 6 L6 18',
  warning: 'M12 3.5 L21.5 20.5 H2.5 Z M12 9.5 V14.5 M12 17.4 m-0.7 0 a0.7 0.7 0 1 0 1.4 0 a0.7 0.7 0 1 0 -1.4 0',
  info: 'M12 12 m-8.5 0 a8.5 8.5 0 1 0 17 0 a8.5 8.5 0 1 0 -17 0 M12 11 V17 M12 7.6 m-0.7 0 a0.7 0.7 0 1 0 1.4 0 a0.7 0.7 0 1 0 -1.4 0',
  chevronDown: 'M6 9.5 L12 15.5 L18 9.5',
  chevronRight: 'M9.5 6 L15.5 12 L9.5 18',
  arrowLeft: 'M19.5 12 H5 M11 6 L5 12 L11 18',
  arrowRight: 'M4.5 12 H19 M13 6 L19 12 L13 18',
  menu: 'M4 7 H20 M4 12 H20 M4 17 H20',
  sun: 'M12 12 m-4.5 0 a4.5 4.5 0 1 0 9 0 a4.5 4.5 0 1 0 -9 0 M12 1.5 V4 M12 20 V22.5 M1.5 12 H4 M20 12 H22.5 M4.6 4.6 L6.4 6.4 M17.6 17.6 L19.4 19.4 M19.4 4.6 L17.6 6.4 M6.4 17.6 L4.6 19.4',
  moon: 'M20 14.5 A8.5 8.5 0 0 1 9.5 4 A8.5 8.5 0 1 0 20 14.5 Z',
  wifi: 'M3 9 C6.5 5.5 17.5 5.5 21 9 M6 12.5 C8.5 10 15.5 10 18 12.5 M9 16 C10.5 14.5 13.5 14.5 15 16 M12 19.4 m-0.7 0 a0.7 0.7 0 1 0 1.4 0 a0.7 0.7 0 1 0 -1.4 0',
  wifiOff: 'M3 9 C5 7 8 6 12 6 M21 9 C19.5 7.7 17.5 6.8 15.5 6.4 M6 12.5 C7 11.6 8.4 11 10 10.7 M18 12.5 C17.4 11.9 16.6 11.4 15.7 11 M12 19.4 m-0.7 0 a0.7 0.7 0 1 0 1.4 0 a0.7 0.7 0 1 0 -1.4 0 M4 4 L20 20',
  logOut: 'M9.5 4 H5 V20 H9.5 M15 8 L19 12 L15 16 M19 12 H9.5',
  key: 'M15 10 m-3.5 0 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0 M12.5 7.5 L4 16 V20 H8 V16.5 H11.5',
  money: 'M3 6 H21 V18 H3 Z M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M6 9.4 m-0.6 0 a0.6 0.6 0 1 0 1.2 0 a0.6 0.6 0 1 0 -1.2 0 M18 14.6 m-0.6 0 a0.6 0.6 0 1 0 1.2 0 a0.6 0.6 0 1 0 -1.2 0',
  coins: 'M12 7 m-5 0 a5 3 0 1 0 10 0 a5 3 0 1 0 -10 0 M7 7 V12 C7 13.7 9.2 15 12 15 C14.8 15 17 13.7 17 12 V7 M7 12 V16 C7 17.7 9.2 19 12 19 C14.8 19 17 17.7 17 16 V12',
  qr: 'M4 4 H10 V10 H4 Z M14 4 H20 V10 H14 Z M4 14 H10 V20 H4 Z M14 14 H17 V17 H14 Z M18.5 18.5 H20.5 V20.5 H18.5 Z M14 20.5 H16.5 M18.5 14 H20.5',
  refresh: 'M19.5 9.5 A8 8 0 1 0 20 14 M19.5 4.5 V9.5 H14.5',
  filter: 'M3 5 H21 L14 13.5 V20.5 L10 18.5 V13.5 Z',
  eye: 'M2.5 12 C6 6.5 18 6.5 21.5 12 C18 17.5 6 17.5 2.5 12 Z M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0',
  lock: 'M6 10.5 H18 V21 H6 Z M9 10.5 V7.5 a3 3 0 0 1 6 0 V10.5 M12 14.5 V17',
  pin: 'M12 21.5 C12 21.5 19 14.5 19 10 a7 7 0 1 0 -14 0 C5 14.5 12 21.5 12 21.5 Z M12 10 m-2.5 0 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0',
  bell: 'M6 16.5 V10 a6 6 0 0 1 12 0 V16.5 L19.5 19.5 H4.5 Z M10 19.5 a2 2 0 0 0 4 0',
  image: 'M4 5 H20 V19 H4 Z M4 15 L9 10.5 L13 14 L16 11.5 L20 15 M8.5 9 m-1.1 0 a1.1 1.1 0 1 0 2.2 0 a1.1 1.1 0 1 0 -2.2 0',
  store: 'M4 9.5 V20 H20 V9.5 M3 9.5 L5.5 4 H18.5 L21 9.5 Z M9.5 20 V14.5 H14.5 V20',
  drag: 'M9 6 H9.01 M9 12 H9.01 M9 18 H9.01 M15 6 H15.01 M15 12 H15.01 M15 18 H15.01',

  /*
   * The till's own set. `star` is the settings hub the reference design puts in a
   * corner of the selling screen — ours opens the drawer, prints, and shows the
   * shift report. `cash`, `percent`, `split` and `calculator` are the payment
   * actions, and `monitor` is the customer-facing display.
   */
  trendUp: 'M4 15.5 L10 9.5 L14 13.5 L20.5 7 M15.5 7 H20.5 V12',
  trendDown: 'M4 8.5 L10 14.5 L14 10.5 L20.5 17 M15.5 17 H20.5 V12',
  star: 'M12 3.5 L14.6 9.2 L20.8 10 L16.3 14.2 L17.5 20.4 L12 17.4 L6.5 20.4 L7.7 14.2 L3.2 10 L9.4 9.2 Z',
  cash: 'M3 6.5 H21 V17.5 H3 Z M8 17.5 V19.5 H16 V17.5 M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M5.6 9.4 m-0.4 0 a0.4 0.4 0 1 0 0.8 0 a0.4 0.4 0 1 0 -0.8 0 M18.4 14.6 m-0.4 0 a0.4 0.4 0 1 0 0.8 0 a0.4 0.4 0 1 0 -0.8 0',
  percent: 'M6.5 17.5 L17.5 6.5 M7.5 6.5 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 M16.5 17.5 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0',
  calculator: 'M5.5 3.5 H18.5 V20.5 H5.5 Z M8.5 7 H15.5 M8.5 11.5 H11 M13 11.5 H15.5 M8.5 15.5 H11 M13 15.5 H15.5',
  split: 'M12 3.5 V9 M12 9 C12 12.5 7.5 12 7.5 15.5 V20.5 M12 9 C12 12.5 16.5 12 16.5 15.5 V20.5 M5 20.5 H10 M14 20.5 H19',
  monitor: 'M3 5 H21 V16 H3 Z M8.5 20.5 H15.5 M12 16 V20.5',
  drawer: 'M3 8.5 H21 V19.5 H3 Z M3 8.5 L4.6 4.5 H19.4 L21 8.5 M4 14 H9.5 M14.5 14 H20',
  copy: 'M9 9 H20 V20 H9 Z M15 5.5 H4 V16.5',
  user: 'M12 11 m-3.8 0 a3.8 3.8 0 1 0 7.6 0 a3.8 3.8 0 1 0 -7.6 0 M4.5 20.5 c0 -4 3.3 -6.6 7.5 -6.6 s7.5 2.6 7.5 6.6',
  spark: 'M11 3 L12.6 8.2 L17.8 9.8 L12.6 11.4 L11 16.6 L9.4 11.4 L4.2 9.8 L9.4 8.2 Z M18.2 15.4 L19 17.6 L21.2 18.4 L19 19.2 L18.2 21.4 L17.4 19.2 L15.2 18.4 L17.4 17.6 Z',
  link: 'M9.5 14.5 L14.5 9.5 M7 11 L5 13 a3.5 3.5 0 0 0 5 5 L12 16 M12 8 L14 6 a3.5 3.5 0 0 1 5 5 L17 13',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
