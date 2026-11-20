import { Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '../../lib/utils';

const GLYPH =
  'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out';
const SHOWN = 'opacity-100 scale-100';
const HIDDEN = 'opacity-0 scale-75';

/** Expand and collapse glyphs in one box, crossfading as `expanded` flips. */
export function ExpandIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <div className={cn('relative w-4 h-4', className)}>
      <Maximize2 className={cn(GLYPH, expanded ? HIDDEN : SHOWN)} />
      <Minimize2 className={cn(GLYPH, expanded ? SHOWN : HIDDEN)} />
    </div>
  );
}
