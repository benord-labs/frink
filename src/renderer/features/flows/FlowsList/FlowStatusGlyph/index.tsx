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
import { Spinner } from '../../../../components/ui/spinner';
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
  const className = cn('size-3.5', FLOW_RUN_TONE_CLASSES[tone]);
  if (glyph === 'live') return <Spinner icon={Icon} speed="slow" className={className} />;
  return <Icon aria-hidden className={className} />;
}
