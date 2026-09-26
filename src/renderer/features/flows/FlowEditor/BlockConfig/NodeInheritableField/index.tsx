/**
 * Shared shell for flow node fields that inherit a flow default with Override / Reset.
 *
 * Exports:
 *  - NodeFieldCard  — stateless card row (icon + label + badge + optional action)
 *  - NodeInheritableField — stateful shell (card ↔ picker toggle, inherited/override/reset logic)
 */

import { Button } from '@benord-labs/frink-primitives';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { BLOCK_CONFIG_FIELD_CARD_CLASS } from '../block-config-chrome';

type NodeFieldCardProps = {
  icon: ReactNode;
  label: string;
  badge?: string;
  action?: ReactNode;
};

export function NodeFieldCard({ icon, label, badge, action }: NodeFieldCardProps): ReactElement {
  return (
    <div className={BLOCK_CONFIG_FIELD_CARD_CLASS}>
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className="truncate text-sm text-muted-foreground">{label}</span>
        {badge ? (
          <span className="shrink-0 rounded-md bg-card/50 px-1 py-0.5 text-[10px] leading-tight text-muted-foreground/70 ring-1 ring-inset ring-border/35">
            {badge}
          </span>
        ) : null}
      </div>
      {action}
    </div>
  );
}

type NodeInheritablePickerProps = {
  hasOverride: boolean;
  onCancel: () => void;
};

type NodeInheritableFieldProps = {
  value: string;
  flowDefault: string | undefined;
  icon: ReactNode;
  inheritedLabel: string;
  /**
   * When true, always start collapsed as a card (even when flowDefault is unset).
   * Use for optional overrides like model, where "no default" is still a valid inherited state.
   * NodeProjectField leaves this false so Mode 3 falls through to the raw picker.
   */
  alwaysCard?: boolean;
  onReset: () => void;
  renderPicker: (props: NodeInheritablePickerProps) => ReactNode;
};

export function NodeInheritableField({
  value,
  flowDefault,
  icon,
  inheritedLabel,
  alwaysCard = false,
  onReset,
  renderPicker,
}: NodeInheritableFieldProps): ReactElement {
  const [showPicker, setShowPicker] = useState(false);

  const flowDefaultTrimmed = flowDefault?.trim() ?? '';

  useEffect(() => setShowPicker(false), [value, flowDefault]);

  const hasOverride = value.trim() !== '';
  const isInherited = !hasOverride && flowDefaultTrimmed !== '';
  const showCard = !hasOverride && (isInherited || alwaysCard);

  const handleReset = (): void => {
    onReset();
    setShowPicker(false);
  };

  if (showCard && !showPicker) {
    return (
      <NodeFieldCard
        icon={icon}
        label={inheritedLabel}
        badge={isInherited ? 'inherited' : undefined}
        action={
          <Button
            variant="ghost"
            onClick={() => setShowPicker(true)}
            className="h-auto shrink-0 p-0 text-xs font-normal"
          >
            Override
          </Button>
        }
      />
    );
  }

  if (showCard && showPicker) {
    return (
      <div className="min-w-0 space-y-1.5">
        <div className="min-w-0 w-full">
          {renderPicker({ hasOverride: false, onCancel: () => setShowPicker(false) })}
        </div>
        <Button
          variant="ghost"
          onClick={() => setShowPicker(false)}
          className="h-auto p-0 text-xs font-normal"
        >
          Cancel override
        </Button>
      </div>
    );
  }

  if (hasOverride) {
    return (
      <div className="min-w-0 space-y-1.5">
        <div className="min-w-0 w-full">
          {renderPicker({ hasOverride: true, onCancel: () => setShowPicker(false) })}
        </div>
        {flowDefaultTrimmed !== '' ? (
          <Button variant="ghost" onClick={handleReset} className="h-auto p-0 text-xs font-normal">
            Reset to flow default
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0 w-full">
      {renderPicker({ hasOverride: false, onCancel: () => setShowPicker(false) })}
    </div>
  );
}
