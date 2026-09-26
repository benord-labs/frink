import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

/** Main-pane inset for OpenSidebarButton and the dock. A context, not a CSS variable or data
 * attribute: those restyle every descendant per toggle (decision: renderer-styling-tailwind-v4). */
export const MainPaneInsetContext = createContext(false);

type Props = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  sidebar?: ReactNode;
  /** Right of the main pane, e.g. the theme editor's dock. */
  dock?: ReactNode;
  children: ReactNode;
  inset: boolean;
  mainClassName?: string;
};

/**
 * Shared geometry for a sidebar beside a full-height main pane, with an optional dock after it.
 * Consumers retain ownership of sidebar chrome and main-pane content.
 */
export function SidebarMainPaneLayout({
  sidebar,
  dock,
  children,
  inset,
  className,
  mainClassName,
  ...props
}: Props): ReactElement {
  return (
    <div
      className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', inset && 'gap-1', className)}
      {...props}
    >
      {sidebar}
      <MainPaneInsetContext.Provider value={inset}>
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            inset && 'ml-1 rounded-xl',
            mainClassName,
          )}
        >
          {children}
        </div>
        {dock}
      </MainPaneInsetContext.Provider>
    </div>
  );
}
