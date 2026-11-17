import { DropdownMenuItem } from '@benord-labs/frink-primitives';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactElement } from 'react';

type Props = {
  show: boolean;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: ComponentProps<typeof DropdownMenuItem>['tone'];
};

/** One Work Queue row action, rendered only when the row offers it. */
export function MenuAction({
  show,
  icon: Icon,
  label,
  onSelect,
  disabled,
  tone,
}: Props): ReactElement | null {
  if (!show) return null;
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled} className="text-xs" tone={tone}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </DropdownMenuItem>
  );
}
