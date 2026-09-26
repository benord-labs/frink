import { Button } from '@benord-labs/frink-primitives';
import { ArrowUp, CornerDownLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { Kbd } from '../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utils';

type AgentSendButtonProps = {
  isStreaming?: boolean;
  isSubmitting?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onStop?: () => void;
  className?: string;
  size?: 'sm' | 'default' | 'lg';
  ariaLabel?: string;
  chatMode?: ChatMode;
  hasContent?: boolean;
};

type ButtonVisualState = {
  isStreaming: boolean;
  isSubmitting: boolean;
  hasContent: boolean;
};

// Module-level helpers: each chunks independently, isn't reallocated per render,
// and keeps the component's branch-heavy display logic out of its cognitive budget.
function getButtonIcon({ isStreaming, isSubmitting, hasContent }: ButtonVisualState) {
  if (isStreaming && !hasContent) {
    return <div className="w-2.5 h-2.5 bg-current rounded-[2px] shrink-0 mx-auto" />;
  }
  if (isSubmitting) return <Loader2 className="size-4 animate-spin" />;
  return <ArrowUp className="size-4" />;
}

function getButtonAriaLabel({
  ariaLabel,
  isStreaming,
  isSubmitting,
  hasContent,
}: ButtonVisualState & { ariaLabel?: string }) {
  if (ariaLabel) return ariaLabel;
  if (isStreaming && !hasContent) return 'Stop generation';
  if (isStreaming && hasContent) return 'Add to queue'; // Alt+Enter steers; see the tooltip.
  if (isSubmitting) return 'Generating...';
  return 'Send message';
}

function getTooltipContent({ isStreaming, isSubmitting, hasContent }: ButtonVisualState) {
  if (isStreaming && !hasContent) {
    return (
      <span className="flex items-center gap-1">
        Stop
        <Kbd className="ms-0.5">Esc</Kbd>
        <span className="text-muted-foreground/60">or</span>
        <Kbd className="-me-1">Ctrl C</Kbd>
      </span>
    );
  }
  if (isStreaming && hasContent) {
    // "Steer", not "Send now": the message no longer aborts the turn, it joins it. Deliberately
    // promises the next STEP rather than immediacy — a long tool call can defer pickup by minutes.
    return (
      <span className="flex items-center gap-1">
        Add to queue
        <Kbd className="ms-0.5">
          <CornerDownLeft className="size-2.5 inline" />
        </Kbd>
        <span className="text-muted-foreground/60">or</span>
        Steer
        <Kbd className="ms-0.5">Alt</Kbd>
        <Kbd className="-me-1">
          <CornerDownLeft className="size-2.5 inline" />
        </Kbd>
      </span>
    );
  }
  if (isSubmitting) return 'Generating...';
  return (
    <span className="flex items-center gap-1">
      Send
      <Kbd className="ms-0.5">
        <CornerDownLeft className="size-2.5 inline" />
      </Kbd>
      <span className="text-muted-foreground/60">or</span>
      Send now
      <Kbd className="ms-0.5">Alt</Kbd>
      <Kbd className="-me-1">
        <CornerDownLeft className="size-2.5 inline" />
      </Kbd>
    </span>
  );
}

export function AgentSendButton({
  isStreaming = false,
  isSubmitting = false,
  disabled = false,
  onClick,
  onStop,
  className = '',
  size = 'sm',
  ariaLabel,
  chatMode = 'agent',
  hasContent = false,
}: AgentSendButtonProps) {
  const shouldShowQueueArrow = isStreaming && hasContent;

  const handleClick = () => {
    if (isStreaming && !hasContent && onStop) {
      onStop();
    } else {
      onClick();
    }
  };

  // Streaming owns its own stop affordance, so honour `disabled` only in the plain send state.
  const isDisabled = !isStreaming && disabled;

  const visualState: ButtonVisualState = { isStreaming, isSubmitting, hasContent };

  const shouldShowGlow = (!isStreaming && !isSubmitting && !disabled) || shouldShowQueueArrow;

  const glowClass = shouldShowGlow
    ? 'shadow-[0_0_0_2px_white,0_0_0_4px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_2px_#1a1a1a,0_0_0_4px_rgba(255,255,255,0.08)]'
    : undefined;

  const modeClass =
    chatMode === 'plan'
      ? 'bg-plan-mode! hover:bg-plan-mode/90! text-background! shadow-none!'
      : chatMode === 'debug'
        ? '!bg-debug-mode hover:!bg-debug-mode/90 !text-debug-mode-foreground shadow-none!'
        : 'bg-foreground! hover:bg-foreground/90! text-background! shadow-none!';

  const [tooltipOpen, setTooltipOpen] = useState(false);

  return (
    <Tooltip delayDuration={1_000} open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size={size === 'default' ? 'sm' : size}
          iconOnly
          className={cn(
            'h-7 w-7 rounded-full transition-[background-color,transform,opacity] duration-150 ease-out active:scale-[0.97] flex',
            glowClass,
            modeClass,
            className,
          )}
          disabled={isDisabled}
          type="button"
          onClick={handleClick}
          aria-label={getButtonAriaLabel({ ...visualState, ariaLabel })}
        >
          {getButtonIcon(visualState)}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{getTooltipContent(visualState)}</TooltipContent>
    </Tooltip>
  );
}
