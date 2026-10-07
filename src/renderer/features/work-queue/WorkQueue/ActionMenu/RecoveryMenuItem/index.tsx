import { type LucideIcon, Play, RotateCcw } from 'lucide-react';
import type { ReactElement } from 'react';
import type { RecoveryKind } from '../../../../../../shared/types/flow-run/resume';
import { MenuAction } from '../MenuAction';

const RECOVERY_ITEMS = {
  continue: { icon: Play, label: 'Continue task' },
  retry: { icon: RotateCcw, label: 'Retry task' },
} satisfies Record<RecoveryKind, { icon: LucideIcon; label: string }>;

type Props = { kind: RecoveryKind | undefined; disabled: boolean; onSelect: () => void };

export function RecoveryMenuItem({ kind, disabled, onSelect }: Props): ReactElement | null {
  if (!kind) return null;
  return <MenuAction show {...RECOVERY_ITEMS[kind]} disabled={disabled} onSelect={onSelect} />;
}
