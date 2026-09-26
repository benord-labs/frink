import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleQuestionMark,
  CircleSlash,
  Clock,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';
import {
  FLOW_RUN_TONE_CLASSES,
  type FlowRunGlyph,
  type FlowRunTone,
} from '../../../../lib/flows/flow-run-state';
import { cn } from '../../../../lib/utils';

const GLYPH_ICONS = {
  never: Circle,
  draft: CircleDashed,
  live: LoaderCircle,
  queued: Clock,
  paused: CirclePause,
  done: CircleCheck,
  cancelled: CircleSlash,
  awaiting: CircleQuestionMark,
  failed: CircleAlert,
} satisfies Record<FlowRunGlyph, LucideIcon>;

type FlowStatusGlyphProps = { glyph: FlowRunGlyph; tone: FlowRunTone };

/** A shape per run state, so status never rests on colour alone. */
export function FlowStatusGlyph({ glyph, tone }: FlowStatusGlyphProps): ReactElement {
  const Icon = GLYPH_ICONS[glyph];
  return (
    <Icon
      aria-hidden
      className={cn(
        'size-3.5',
        glyph === 'live' && 'motion-safe:animate-[spin_1.5s_linear_infinite]',
        FLOW_RUN_TONE_CLASSES[tone],
      )}
    />
  );
}
