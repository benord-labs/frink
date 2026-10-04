import { useState } from 'react';
import { ChipButton } from './chip';
import { OptionRow, Sheet, SheetSection } from './sheet';

export type MenuGroup = {
  title?: string;
  /** The chosen option's id; a group of plain actions has none. */
  value?: string;
  options: Array<{ id: string; label: string }>;
  onPick: (id: string) => void;
};
export type MenuChipProps = {
  label: string;
  accessibilityLabel: string;
  groups: MenuGroup[];
  disabled?: boolean;
};

/** A word and a caret that open one choice. Off iOS the choice is a sheet of ticked rows. */
export function MenuChip({ label, accessibilityLabel, groups, disabled = false }: MenuChipProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ChipButton
        label={label}
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      {open && (
        <Sheet title={accessibilityLabel.split(':')[0]} onClose={() => setOpen(false)}>
          {groups.map((group, index) => (
            <SheetSection key={group.title ?? index} title={group.title}>
              {group.options.map((option) => (
                <OptionRow
                  key={option.id}
                  title={option.label}
                  selected={option.id === group.value}
                  onPress={() => {
                    setOpen(false);
                    // Re-picking the current choice changes nothing, so nothing is saved.
                    if (option.id !== group.value) group.onPick(option.id);
                  }}
                />
              ))}
            </SheetSection>
          ))}
        </Sheet>
      )}
    </>
  );
}
