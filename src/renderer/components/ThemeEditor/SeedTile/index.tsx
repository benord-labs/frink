import type { ReactElement } from 'react';
import { SELECTED_ROLE_CLASS } from '@/lib/themes/editor/role-list';
import { cn } from '@/lib/utils';
import { ColorField } from '../ColorField';

type Props = {
  role: 'background' | 'accent';
  label: string;
  description: string;
  /** `#rrggbb` */
  value: string;
  onChange: (hex: string) => void;
  selected: boolean;
};

/** One of the two colours a theme is made from: a cut-corner swatch, its hex and what it paints. */
export function SeedTile({
  role,
  label,
  description,
  value,
  onChange,
  selected,
}: Props): ReactElement {
  return (
    <ColorField label={label} value={value} onChange={onChange} size="seed">
      {({ swatch, hex }) => (
        <div
          data-theme-role={role}
          className={cn(
            'flex min-w-0 flex-col gap-2 rounded-[10px] bg-input-background/60 p-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)]',
            selected && SELECTED_ROLE_CLASS,
          )}
        >
          {swatch}
          <span className="flex items-baseline justify-between gap-1 text-[13px] font-medium">
            {label}
            {hex}
          </span>
          <span className="-mt-1 text-xs leading-snug text-muted-foreground">{description}</span>
        </div>
      )}
    </ColorField>
  );
}
