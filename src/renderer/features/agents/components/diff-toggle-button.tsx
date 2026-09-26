import { Button } from '@benord-labs/frink-primitives';
import { memo } from 'react';
import { Diff, Loader2 } from 'lucide-react';
import { Kbd } from '../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';

type DiffToggleButtonProps = {
  isLoading: boolean;
  hasChanges: boolean;
  onClick?: () => void;
};

/** Shared diff / view-changes toggle. Wrapping (backdrop-blur) is handled by PaneUtilityButtons. */
export const DiffToggleButton = memo(function DiffToggleButton({
  isLoading,
  hasChanges,
  onClick,
}: DiffToggleButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClick}
          className="h-6 w-6 p-0 text-foreground transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md flex"
          aria-label="View changes"
          iconOnly
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Diff className="h-4 w-4" />}
          <span className="sr-only">View changes</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {isLoading ? (
          'Loading changes...'
        ) : hasChanges ? (
          <>
            <span>View changes</span>
            <Kbd shortcutId="open-diff" />
          </>
        ) : (
          'No changes'
        )}
      </TooltipContent>
    </Tooltip>
  );
});
