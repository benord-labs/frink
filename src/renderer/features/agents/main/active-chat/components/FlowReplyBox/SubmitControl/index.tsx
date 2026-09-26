/**
 * FlowReplyBox's submit affordance, split out so the parent's cognitive complexity does not grow
 * with each variant.
 *
 * 'reply' is a labelled button; the two glyph variants differ only in their DATA, so they live in a
 * lookup rather than a ternary at each attribute. 'steer' reaches the RUNNING step without aborting
 * it, which is why it can finally name what it does — but it still promises the next STEP, never
 * immediacy: a long tool call defers pickup.
 */
import { Button } from '@benord-labs/frink-primitives';
import { ArrowUp, Navigation } from 'lucide-react';

export type FlowSubmitKind = 'reply' | 'queue' | 'steer';

const GLYPH_SUBMIT = {
  queue: {
    label: 'Add to queue',
    title: 'Add to queue — delivered when this step finishes',
    Icon: ArrowUp,
  },
  steer: {
    label: 'Steer',
    title: 'Steer — the running step picks this up next',
    Icon: Navigation,
  },
} as const;

type Props = {
  kind: FlowSubmitKind;
  disabled: boolean;
  onSubmit: () => void;
};

export function SubmitControl({ kind, disabled, onSubmit }: Props) {
  if (kind === 'reply') {
    return (
      <Button type="button" size="sm" onClick={onSubmit} disabled={disabled}>
        Reply
      </Button>
    );
  }
  const glyph = GLYPH_SUBMIT[kind];
  return (
    <Button
      type="button"
      size="sm"
      iconOnly
      className="h-7 w-7 shrink-0 rounded-full"
      onClick={onSubmit}
      disabled={disabled}
      aria-label={glyph.label}
      title={glyph.title}
    >
      <glyph.Icon className="size-4" aria-hidden />
    </Button>
  );
}
