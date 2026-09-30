import type { ReactElement } from 'react';
import { Slider } from '../../../../../components/ui/slider';
import type { ModelItem } from '../../model-selector';
import { UltraSwitch } from '../UltraSwitch';

/** Shown when the Extra High stop is dropped — a user-reachable action (packaged users update the app). */
const XHIGH_HIDDEN_HINT = 'Extra High needs a newer Claude CLI — update Frink to enable it.';

/** Why Extra High is missing, then the Ultra switch (`ultra` undefined: not offered here). */
export function EffortFooter({
  xhighHidden,
  ultra,
  onUltra,
}: {
  xhighHidden: boolean;
  ultra: boolean | undefined;
  onUltra: (on: boolean) => void;
}): ReactElement {
  return (
    <>
      {xhighHidden ? (
        <p className="text-xs leading-snug text-muted-foreground">{XHIGH_HIDDEN_HINT}</p>
      ) : null}
      {ultra !== undefined ? <UltraSwitch checked={ultra} onChange={onUltra} /> : null}
    </>
  );
}

/** One stop per tier; moving it reports the new effort. */
export function EffortSlider({
  tiers,
  effort,
  disabled,
  onEffort,
}: {
  tiers: ModelItem[];
  effort: ModelItem['effort'];
  disabled: boolean;
  onEffort: (effort: ModelItem['effort']) => void;
}): ReactElement {
  const index = Math.max(
    0,
    tiers.findIndex((t) => t.effort === effort),
  );
  return (
    <Slider
      min={0}
      max={tiers.length - 1}
      step={1}
      value={[index]}
      disabled={disabled}
      thumbLabel="Effort"
      onValueChange={([i]) => {
        const next = tiers[i];
        if (next && next.effort !== effort) onEffort(next.effort);
      }}
    />
  );
}
