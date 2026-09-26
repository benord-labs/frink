import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  GitCompareArrows,
  type LucideIcon,
  OctagonX,
  Workflow,
} from 'lucide-react';
import type { FlowChangePhase } from '../../../../shared/types/flows/flow-change-presentation';

type PhaseMeta = {
  icon: LucideIcon;
  label: string;
};

export const PHASE_META: Record<FlowChangePhase, PhaseMeta> = {
  proposed: { icon: Workflow, label: 'Not applied' },
  applying: { icon: CircleDashed, label: 'Applying' },
  applied: { icon: CheckCircle2, label: 'Applied' },
  partial: { icon: AlertTriangle, label: 'Partial' },
  unchanged: { icon: CheckCircle2, label: 'Already current' },
  failed: { icon: OctagonX, label: 'Failed' },
  unconfirmed: { icon: CircleHelp, label: 'Unconfirmed' },
  denied: { icon: Ban, label: 'Not approved' },
  stale: { icon: GitCompareArrows, label: 'Out of date' },
  interrupted: { icon: CircleHelp, label: 'Unconfirmed' },
};
