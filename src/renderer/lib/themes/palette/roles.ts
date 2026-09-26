/** The 18 colour roles a Frink theme paints. Order is stable: the inspector indexes by it. */
export const ROLES = [
  'background',
  'surface',
  'sidebar',
  'overlay',
  'field',
  'muted',
  'subtleSurface',
  'highlightSurface',
  'text',
  'mutedText',
  'subtleForeground',
  'highlightForeground',
  'accent',
  'accentForeground',
  'border',
  'input',
  'destructive',
  'destructiveForeground',
] as const;

export type Role = (typeof ROLES)[number];

/** One `#rrggbb` colour per role. */
export type Palette = Record<Role, string>;

/** Colours a theme pins instead of deriving. */
export type RoleOverrides = Partial<Palette>;

export type Appearance = 'light' | 'dark';

/** CSS vars each role writes on <html>, as `H S% L%` triplets. `--selection` is written by apply. */
export const ROLE_VARS = {
  background: ['--background'],
  surface: ['--card'],
  sidebar: ['--tl-background'],
  overlay: ['--popover'],
  field: ['--input-background'],
  muted: ['--muted'],
  subtleSurface: ['--secondary'],
  highlightSurface: ['--accent'],
  text: ['--foreground', '--card-foreground', '--popover-foreground'],
  mutedText: ['--muted-foreground'],
  subtleForeground: ['--secondary-foreground'],
  highlightForeground: ['--accent-foreground'],
  accent: ['--primary', '--ring'],
  accentForeground: ['--primary-foreground'],
  border: ['--border'],
  input: ['--input'],
  destructive: ['--destructive'],
  destructiveForeground: ['--destructive-foreground'],
} as const satisfies Record<Role, readonly string[]>;

/** User-facing role names in the theme editor and inspector. */
export const ROLE_LABELS = {
  background: 'Window',
  surface: 'Panels & sidebar',
  sidebar: 'Side panels & dialogs',
  overlay: 'Menus & popups',
  field: 'Input boxes',
  muted: 'Soft fill',
  subtleSurface: 'Buttons',
  highlightSurface: 'Hover highlight',
  text: 'Text',
  mutedText: 'Faded text',
  subtleForeground: 'Text on buttons',
  highlightForeground: 'Text on hover highlight',
  accent: 'Accent',
  accentForeground: 'Text on accent',
  border: 'Borders',
  input: 'Input borders',
  destructive: 'Error',
  destructiveForeground: 'Text on error',
} satisfies Record<Role, string>;

/** Theme editor "All colors" sections, in display order. */
export const ROLE_GROUPS: readonly { label: string; roles: readonly Role[] }[] = [
  {
    label: 'Backgrounds',
    roles: [
      'background',
      'surface',
      'sidebar',
      'overlay',
      'field',
      'muted',
      'subtleSurface',
      'highlightSurface',
    ],
  },
  { label: 'Text', roles: ['text', 'mutedText', 'subtleForeground', 'highlightForeground'] },
  {
    label: 'Lines and signals',
    roles: [
      'accent',
      'accentForeground',
      'border',
      'input',
      'destructive',
      'destructiveForeground',
    ],
  },
];
