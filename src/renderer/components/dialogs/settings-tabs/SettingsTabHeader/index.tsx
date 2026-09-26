import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  SETTINGS_TAB_HEADING_STACK_CLASS,
  SETTINGS_TAB_TITLE_CLASS,
} from '../settings-tab-surface';

type SettingsTabHeaderProps = {
  title: string;
  /** Omit for title-only blocks (e.g. Account). */
  description?: ReactNode;
  /** Compact typography for narrow settings panel / small breakpoints. */
  narrow?: boolean;
  /** Use `h1` for top-level settings page title (e.g. Account). */
  titleAs?: 'h1' | 'h2';
  /** Trailing controls (refresh, MCP actions, etc.). */
  actions?: ReactNode;
  /**
   * With `actions`: `stack` = column then `sm` row (default). `inline` = single row with
   * `items:center` (e.g. narrow Machines tab + refresh).
   */
  actionsRowLayout?: 'stack' | 'inline';
  /** Merged onto the title + description stack (e.g. `min-w-0 flex-1`). */
  stackClassName?: string;
  className?: string;
};

function hasDescription(description: SettingsTabHeaderProps['description']): boolean {
  if (description == null) {
    return false;
  }
  if (typeof description === 'string') {
    return description.trim() !== '';
  }
  return true;
}

export function SettingsTabHeader({
  title,
  description,
  narrow = false,
  titleAs = 'h2',
  actions,
  actionsRowLayout = 'stack',
  stackClassName,
  className,
}: SettingsTabHeaderProps): ReactElement {
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  const TitleTag = titleAs === 'h1' ? 'h1' : 'h2';
  const titleClass = narrow
    ? 'text-lg font-semibold tracking-tight text-foreground'
    : SETTINGS_TAB_TITLE_CLASS;

  const headingStack = (
    <>
      <TitleTag className={titleClass}>{title}</TitleTag>
      {hasDescription(description) ? (
        <p className={narrow ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}>
          {description}
        </p>
      ) : null}
    </>
  );

  if (!actions) {
    return (
      <div className={cn(SETTINGS_TAB_HEADING_STACK_CLASS, stackClassName, className)}>
        {headingStack}
      </div>
    );
  }

  const outer =
    actionsRowLayout === 'inline'
      ? 'flex items-center justify-between gap-2'
      : 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between';

  return (
    <div className={cn(outer, className)}>
      <div className={cn(SETTINGS_TAB_HEADING_STACK_CLASS, stackClassName)}>{headingStack}</div>
      {actions}
    </div>
  );
}
