/**
 * Per-pane color tokens: sidebar badges, split borders, permission toast, highlight ring.
 */
import { BUTTON_SHADOW } from './button-shadow';
import { cn } from './utils';

const PANE_COLORS = [
  {
    border: 'border-primary/80',
    borderSubtle: 'border-primary/50',
    bg: 'bg-primary/5',
    badgeBg: 'bg-primary/20',
    badgeText: 'text-primary',
    badgeBorder: 'border-primary/40',
    sidebarBg: 'bg-primary/15',
  },
  {
    border: 'border-pane-accent/80',
    borderSubtle: 'border-pane-accent/50',
    bg: 'bg-pane-accent/5',
    badgeBg: 'bg-pane-accent/20',
    badgeText: 'text-pane-accent',
    badgeBorder: 'border-pane-accent/40',
    sidebarBg: 'bg-pane-accent/15',
  },
  {
    border: 'border-status-online/80',
    borderSubtle: 'border-status-online/50',
    bg: 'bg-status-online/5',
    badgeBg: 'bg-status-online/20',
    badgeText: 'text-status-online',
    badgeBorder: 'border-status-online/40',
    sidebarBg: 'bg-status-online/15',
  },
  {
    border: 'border-plan-mode/80',
    borderSubtle: 'border-plan-mode/50',
    bg: 'bg-plan-mode/5',
    badgeBg: 'bg-plan-mode/20',
    badgeText: 'text-plan-mode',
    badgeBorder: 'border-plan-mode/40',
    sidebarBg: 'bg-plan-mode/15',
  },
] as const;

type PaneColor = (typeof PANE_COLORS)[number];

export function getPaneColor(index: number): PaneColor {
  return PANE_COLORS[index % PANE_COLORS.length];
}

/** [primary CTA class override | undefined, split `divide-x`]. Index 0 = theme primary button. */
const PERMISSION_CTA: [string | undefined, string][] = [
  [undefined, 'divide-primary-foreground/30'],
  [
    cn(
      'bg-pane-accent text-pane-accent-foreground hover:bg-pane-accent/90',
      BUTTON_SHADOW,
      'focus-visible:outline-pane-accent/70',
    ),
    'divide-pane-accent-foreground/30',
  ],
  [
    cn(
      'bg-status-online text-status-online-foreground hover:bg-status-online/90',
      BUTTON_SHADOW,
      'focus-visible:outline-status-online/70',
    ),
    'divide-status-online-foreground/30',
  ],
  [
    cn(
      'bg-plan-mode text-plan-mode-foreground hover:bg-plan-mode/90',
      BUTTON_SHADOW,
      'focus-visible:outline-plan-mode/70',
    ),
    'divide-plan-mode-foreground/30',
  ],
];

const RING = [
  'ring-primary/60',
  'ring-pane-accent/60',
  'ring-status-online/60',
  'ring-plan-mode/60',
] as const;

export function getPanePermissionChrome(paneIndex0: number) {
  const i = paneIndex0 % PANE_COLORS.length;
  const c = getPaneColor(i);
  const [primaryCtaClassName, splitDividerClassName] = PERMISSION_CTA[i];
  return {
    badgeClassName: cn(
      'inline-flex items-center gap-1 border px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
      c.badgeBg,
      c.badgeText,
      c.badgeBorder,
    ),
    primaryCtaClassName,
    splitDividerClassName,
  };
}

export function getPanePermissionHighlightRing(paneIndex0: number): string {
  return cn(
    'ring-2 ring-inset',
    RING[paneIndex0 % RING.length],
    'motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500',
  );
}
