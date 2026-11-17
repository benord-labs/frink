import type { ReactElement, ReactNode } from 'react';
import { Label } from '../../../../../components/ui/label';
import { Switch } from '../../../../../components/ui/switch';

/** One Flow setting: a title, what it does, and its switch. `children` sits under the description. */
export function SettingSwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  id: string;
  label: string;
  description: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}): ReactElement {
  const descriptionId = `${id}-description`;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <Label htmlFor={id} className="text-xs font-medium">
          {label}
        </Label>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
        {children}
      </div>
      <Switch
        id={id}
        aria-describedby={descriptionId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
