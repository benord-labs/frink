import { Button } from '@benord-labs/frink-primitives';
import { GitCompare } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type Props = {
  /** Whether the tree is currently filtered to git-modified files. */
  active: boolean;
  onToggle: () => void;
};

/**
 * Header toggle that filters the file tree down to git-modified files.
 *
 * Shared by the sidebar and split-pane file trees, which render an identical control.
 */
export function ModifiedOnlyToggle({ active, onToggle }: Props) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggle}
          className={cn(
            'ml-auto h-8 w-8 shrink-0',
            active
              ? 'bg-foreground/10 text-primary'
              : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
          )}
          aria-pressed={active}
          aria-label="Show modified files only"
          iconOnly
        >
          <GitCompare className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {active ? 'Show all files' : 'Show modified only'}
      </TooltipContent>
    </Tooltip>
  );
}
