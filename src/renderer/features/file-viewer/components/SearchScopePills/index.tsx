import { Button } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  roots: Array<{ path: string; name: string }>;
  /** The one folder searched, or null for all of them */
  scope: string | null;
  onScopeChange: (scope: string | null) => void;
};

/** Narrows a search to one project in the file tree, or widens it to all of them. */
export function SearchScopePills({ roots, scope, onScopeChange }: Props): ReactElement {
  const pills = [{ path: null, name: 'All in this tree' }, ...roots];
  return (
    <div role="group" aria-label="Search scope" className="flex flex-wrap gap-1 px-2 pb-1.5">
      {pills.map(({ path, name }) => {
        const active = path === scope;
        return (
          <Button
            key={path ?? ''}
            variant="ghost"
            size="xs"
            shape="pill"
            // The full name too, since a long one is cut off on the pill.
            title={path === null ? undefined : `${name} · ${path}`}
            aria-pressed={active}
            onClick={() => onScopeChange(path)}
            // The chosen pill stands out by its weight and stronger outline, so colour is never the
            // only cue.
            className={cn(
              'max-w-48 border',
              active
                ? 'border-foreground/40 bg-primary/15 font-semibold text-foreground hover:bg-primary/15'
                : 'border-border/60 font-normal text-muted-foreground hover:border-border hover:text-foreground',
            )}
          >
            <span className="truncate">{name}</span>
          </Button>
        );
      })}
    </div>
  );
}
