import { Button } from '@benord-labs/frink-primitives';
import { TerminalSquare } from 'lucide-react';
import { memo } from 'react';
import { Kbd } from '../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';

type TerminalToggleButtonProps = {
  onClick?: () => void;
  isOpen?: boolean;
};

/** Shared terminal toggle button. Wrapping (backdrop-blur) is handled by PaneUtilityButtons. */
export const TerminalToggleButton = memo(function TerminalToggleButton({
  onClick,
  isOpen = false,
}: TerminalToggleButtonProps) {
  const label = isOpen ? 'Close terminal' : 'Open terminal';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClick}
          aria-label={label}
          aria-pressed={isOpen}
          className="h-6 w-6 p-0 text-foreground transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] shrink-0 rounded-md flex"
          iconOnly
        >
          <TerminalSquare className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>{label}</span>
        <Kbd shortcutId="toggle-terminal" />
      </TooltipContent>
    </Tooltip>
  );
});
