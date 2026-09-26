import { Button } from '@benord-labs/frink-primitives';
import { Code, Type, Check, Copy } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { cn } from '../../../lib/utils';
import { useHaptic } from '../hooks/use-haptic';

// ============================================================================
// COPY BUTTON - Memoized component for copying text
// ============================================================================

type CopyButtonProps = {
  text: string;
  isMobile?: boolean;
};

export const CopyButton = memo(function CopyButton({
  text,
  isMobile: _isMobile = false,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const { trigger: triggerHaptic } = useHaptic();

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    triggerHaptic('medium');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text, triggerHaptic]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCopy();
      }
    },
    [handleCopy],
  );

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      aria-label="Copy message"
      className="rounded-md transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
    >
      <div className="relative w-3.5 h-3.5">
        <Copy
          className={cn(
            'absolute inset-0 w-3.5 h-3.5 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
            copied ? 'opacity-0 scale-50' : 'opacity-100 scale-100',
          )}
        />
        <Check
          className={cn(
            'absolute inset-0 w-3.5 h-3.5 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
            copied ? 'opacity-100 scale-100' : 'opacity-0 scale-50',
          )}
        />
      </div>
    </Button>
  );
});

// ============================================================================
// MARKDOWN TOGGLE - switches a bubble between rendered markdown and raw text
// ============================================================================

type MarkdownToggleButtonProps = {
  /** Whether the bubble is currently rendering markdown. */
  rendered: boolean;
  onToggle: () => void;
};

export const MarkdownToggleButton = memo(function MarkdownToggleButton({
  rendered,
  onToggle,
}: MarkdownToggleButtonProps) {
  // Label/icon describe the NEXT action, not the current state.
  const label = rendered ? 'View raw text' : 'Render markdown';
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      aria-label={label}
      title={label}
      // Opaque resting bg so the control never bleeds into message text behind it; keep the
      // hover opaque too (the ghost hover overlay is translucent and would re-expose text).
      className="bg-muted hover:bg-accent rounded-md transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
    >
      {rendered ? (
        <Code className="w-3.5 h-3.5 text-muted-foreground" />
      ) : (
        <Type className="w-3.5 h-3.5 text-muted-foreground" />
      )}
    </Button>
  );
});

// ============================================================================
// HELPER - Get text content from message
// ============================================================================

// One extractor, one home. This used to be a second, text-only copy, so a message part that reads
// as text without being a `text` part — a subagent's prose — was copyable from neither.
export { getMessageTextContent } from '../main/active-chat/utils/message-helpers';
