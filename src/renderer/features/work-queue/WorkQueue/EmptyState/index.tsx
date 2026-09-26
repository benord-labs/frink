/**
 * EmptyState Component
 * Displays empty state when work queue has no tasks
 */

import { Button } from '@benord-labs/frink-primitives';
import { Inbox } from 'lucide-react';
import type { ReactElement } from 'react';

type EmptyStateProps = {
  onOpenSettings?: () => void;
};

export function EmptyState({ onOpenSettings }: EmptyStateProps): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="relative mb-4 flex h-14 w-14 items-center justify-center rounded-xl border border-border/60 bg-card/70">
        <span className="absolute inset-0 animate-pulse rounded-xl border border-[hsl(var(--primary)/0.35)] motion-reduce:animate-none" />
        <Inbox className="h-6 w-6 text-[hsl(var(--primary))]" aria-hidden />
      </div>
      <p className="text-sm font-semibold text-foreground">Queue is empty</p>
      <p className="mt-1 max-w-[260px] text-xs text-muted-foreground">
        New tasks appear here when triggered via webhooks or manual creation.
      </p>
      <Button
        variant="secondary"
        size="sm"
        onClick={onOpenSettings}
        className="mt-4 border-border/70 px-3 text-[11px] text-muted-foreground hover:bg-card hover:text-foreground"
      >
        Open Flows to add a webhook trigger
      </Button>
    </div>
  );
}
