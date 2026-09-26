import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Inner frosted glass panel — shared by Agents sidebar, Details, expanded widget, Settings nav.
 * Styled via `.unified-sidebar-glass` in agents-styles.css (frost when inside `[data-agents-page]`,
 * or on the same node as `[data-agents-page]` — see agents-styles.css compound selectors).
 */
export const UNIFIED_GLASS_INNER_CLASS = cn(
  'unified-sidebar-glass flex min-h-0 flex-1 flex-col overflow-hidden',
);

/**
 * Right-edge inset (Details / expanded widget) — gap from resize strip + window chrome.
 */
const DETAILS_ROOT_INSET_CLASS = cn(
  'flex h-full min-h-0 w-full min-w-0 flex-1 flex-col pl-1 pr-2 pt-2 pb-2',
);

function unifiedLeftSidebarOuterClass(isMobileFullscreen: boolean): string {
  return cn(
    'flex h-full min-h-0 flex-col overflow-hidden select-none',
    isMobileFullscreen ? 'mr-1 pt-1.5 pb-1.5 pl-1.5 pr-0' : 'mr-1 pt-2 pb-2 pl-2 pr-0',
  );
}

/**
 * Div props for the outer shell. Explicit `data-unified-sidebar` — TS `ComponentPropsWithoutRef<'div'>`
 * does not list every `data-*` attribute in all @types/react versions.
 */
type InsetGlassSidebarOuterProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  'data-unified-sidebar'?: string | boolean;
};

type InsetGlassSidebarShellProps = {
  edge: 'left' | 'right';
  isMobileFullscreen?: boolean;
  className?: string;
  glassClassName?: string;
  /** Merged onto the outer inset wrapper (e.g. `data-unified-sidebar`). */
  outerProps?: InsetGlassSidebarOuterProps;
  children: ReactNode;
};

/**
 * Shared root for inset “glass” sidebars: outer margin/padding + inner `unified-sidebar-glass`.
 */
export function InsetGlassSidebarShell({
  edge,
  isMobileFullscreen = false,
  className,
  glassClassName,
  outerProps,
  children,
}: InsetGlassSidebarShellProps) {
  const { className: outerClassFromProps, ...restOuter } = outerProps ?? {};
  const outerClass =
    edge === 'left'
      ? cn(unifiedLeftSidebarOuterClass(isMobileFullscreen), className, outerClassFromProps)
      : cn(DETAILS_ROOT_INSET_CLASS, className, outerClassFromProps);

  return (
    <div className={outerClass} {...restOuter}>
      <div className={cn(UNIFIED_GLASS_INNER_CLASS, glassClassName)}>{children}</div>
    </div>
  );
}
