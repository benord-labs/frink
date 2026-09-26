import { Button } from '@benord-labs/frink-primitives';
import { ChevronRight } from 'lucide-react';
import type { RefObject } from 'react';

type Props = {
  name?: string;
  onBack: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
};

/** Owns the page's h1, so the header below is not a second heading. */
export function PluginBreadcrumb({ name, onBack, headingRef }: Props) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 pb-6">
      <Button variant="ghost" size="sm" className="h-7 shrink-0 px-1.5 text-sm" onClick={onBack}>
        Plugins
      </Button>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-fg" aria-hidden />
      <h1
        ref={headingRef}
        tabIndex={-1}
        aria-current="page"
        className="min-w-0 truncate font-semibold text-ink text-sm outline-none"
      >
        {name ?? 'Plugin'}
      </h1>
    </nav>
  );
}
