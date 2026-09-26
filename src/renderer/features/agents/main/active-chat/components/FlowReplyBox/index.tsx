/**
 * FlowReplyBox — the ONE full-width reply control shared by every flow-chat bottom surface: the
 * parked answer box, the paused bar, and the running strip's note field. Full-width because these
 * surfaces REPLACE the composer, and a cramped inline field is not somewhere anyone types a real
 * instruction.
 *
 * `bare` drops the composer shell for a caller that already owns a card (FlowRunStrip). `submit`
 * picks the affordance: 'reply' is a labelled button; 'queue' is the composer's own ↑ glyph and
 * "Add to queue" wording (mirrors AgentSendButton mid-stream); 'steer' delivers into the running
 * step instead of waiting for it. Only the RUNNING strip may pass 'steer' — the parked and paused
 * surfaces have no live turn to steer, and reaching them through this control would bypass the
 * unpark/resume lifecycle they own.
 *
 * Text is uncontrolled by default; pass `value` + `onChange` to lift it (the running strip parks it
 * in an atom so an unsent note survives the strip unmounting).
 */
import { Button, Input } from '@benord-labs/frink-primitives';
import { X } from 'lucide-react';
import { memo, useState } from 'react';
import { stripHiddenWakeMarker } from '../../../../../../../shared/lib/message-markers/hidden-wake-marker';
import { agentsChatComposerShellClass } from '../../../chat-composer-shell-classes';
import { type FlowSubmitKind, SubmitControl } from './SubmitControl';

type FlowReplyBoxProps = {
  /** The agent's ask, rendered above the input. Omit where the surrounding row already says it. */
  summary?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** 'reply' = labelled button; 'queue' = the composer's ↑ / "Add to queue" control; 'steer' =
   * same glyph, but the note reaches the step it annotates instead of queueing behind it. */
  submit?: FlowSubmitKind;
  /** Skip the composer shell — for a caller that already renders one. */
  bare?: boolean;
  autoFocus?: boolean;
  /**
   * Dismiss handler. `reason` lets the caller treat the two differently: the ✕ is labelled and means
   * discard, while Escape is pressed reflexively to shed focus and carries no such contract — it
   * must not destroy a paragraph.
   */
  onCancel?: (reason: 'button' | 'escape') => void;
  /** Lifted draft. Omit for local state. */
  value?: string;
  onChange?: (text: string) => void;
  /** Locks the input and every submit/dismiss affordance while a continuation is in flight. */
  disabled?: boolean;
  /** Sends the text; returns whether it actually sent (false keeps the text so the user can retry). */
  onSubmit: (text: string) => boolean;
};

function isSubmitDisabled(disabled: boolean, text: string): boolean {
  return disabled || !text.trim();
}

export const FlowReplyBox = memo(function FlowReplyBox({
  summary,
  placeholder = 'Reply to continue…',
  ariaLabel = 'Reply to the agent',
  submit = 'reply',
  bare = false,
  autoFocus = false,
  onCancel,
  value,
  onChange,
  disabled = false,
  onSubmit,
}: FlowReplyBoxProps) {
  const [innerText, setInnerText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const text = value ?? innerText;
  const setText = onChange ?? setInnerText;
  const submitDisabled = isSubmitDisabled(disabled, text);

  const send = () => {
    // Human intake: a literally-typed internal wake marker must never persist as one
    // (it would vanish from the transcript and read as an already-dispatched wake).
    const trimmed = stripHiddenWakeMarker(text.trim()).trim();
    if (!trimmed) return;
    if (onSubmit(trimmed)) {
      setText('');
    }
  };

  const row = (
    <>
      {summary ? (
        <p className="mb-2 text-sm text-muted-foreground" title={summary}>
          {summary}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          autoFocus={autoFocus}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            if (e.key === 'Escape') onCancel?.('escape');
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
        />
        {/* Dismiss sits beside the input it dismisses, which is where people look for it. Low
            stakes (it discards a draft, not a run), so proximity to submit is the right trade —
            unlike Stop, which stays a row away. */}
        {onCancel ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            iconOnly
            className="h-7 w-7 shrink-0 rounded-full text-muted-foreground"
            onClick={() => onCancel('button')}
            disabled={disabled}
            aria-label="Discard message"
            title="Discard"
          >
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
        <SubmitControl kind={submit} disabled={submitDisabled} onSubmit={send} />
      </div>
    </>
  );

  return bare ? row : <div className={agentsChatComposerShellClass(false, isFocused)}>{row}</div>;
});
