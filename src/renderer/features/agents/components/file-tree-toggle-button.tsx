import { Folder } from 'lucide-react';
import { Button } from '@benord-labs/frink-primitives';
import { memo } from 'react';
import { Kbd } from '../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utils';

type FileTreeToggleButtonProps = {
  isOpen: boolean;
  hasModifiedFiles: boolean;
  onToggle: () => void;
};

/** Shared file tree toggle button. Wrapping (backdrop-blur) is handled by PaneUtilityButtons. */
export const FileTreeToggleButton = memo(function FileTreeToggleButton({
  isOpen,
  hasModifiedFiles,
  onToggle,
}: FileTreeToggleButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggle}
          className={cn(
            'relative h-6 w-6 p-0 text-foreground transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md flex',
            isOpen ? 'text-foreground bg-foreground/10' : '',
          )}
          aria-label={isOpen ? 'Hide files' : 'Show files'}
          aria-pressed={isOpen}
          iconOnly
        >
          <Folder className="h-4 w-4" aria-hidden="true" />
          {hasModifiedFiles && (
            <span
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background"
              aria-hidden
            />
          )}
          <span className="sr-only">{isOpen ? 'Hide files' : 'Show files'}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {isOpen ? 'Hide files' : 'Show files'}
        {hasModifiedFiles && ' (modified files)'}
        <Kbd shortcutId="toggle-files" />
      </TooltipContent>
    </Tooltip>
  );
});
