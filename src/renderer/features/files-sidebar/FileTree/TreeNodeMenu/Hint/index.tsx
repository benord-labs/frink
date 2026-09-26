import type { ReactElement } from 'react';

/** Right-aligned shortcut hint for a context-menu item; renders nothing when empty. */
export function Hint({ text }: { text: string }): ReactElement | null {
  return text ? <span className="ml-auto pl-4 text-xs text-muted-foreground">{text}</span> : null;
}
