import { Button } from '@benord-labs/frink-primitives';
import { RotateCcw } from 'lucide-react';
import { type ComponentType, memo, type ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';

type Props = {
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel: string;
  /** When true, sets `aria-busy` on the control (e.g. retry request in flight). */
  ariaBusy?: boolean;
  tooltipText?: string;
  label?: string;
  /** Leading glyph — defaults to the retry arrow; e.g. Play for a Continue action. */
  icon?: ComponentType<{ className?: string }>;
};

export const RetryActionButton = memo(function RetryActionButton({
  onClick,
  disabled = false,
  ariaLabel,
  ariaBusy = false,
  tooltipText,
  label = 'Retry',
  icon: Icon = RotateCcw,
}: Props): ReactElement {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="h-7 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground rounded-md"
      aria-label={ariaLabel}
      aria-busy={ariaBusy || undefined}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </Button>
  );

  if (!tooltipText) return button;

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
});
