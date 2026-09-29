import type { ReactElement } from 'react';
import {
  CODEX_FAST_SPEED_MULTIPLIER,
  CODEX_ULTRAFAST_SPEED_MULTIPLIER,
  codexTierCredits,
} from '../../../../../../shared/lib/codex-cli-models';
import type { CodexSpeed } from '../../../../../../shared/types/execution';
import type { FlowSettings } from '../../../../../../shared/types/flow';
import { Label } from '../../../../../components/ui/label';
import { Switch } from '../../../../../components/ui/switch';
import { patch } from '../patch';

/** Copy for the Flow-level Fast switch; keeps speed and ChatGPT credit use as separate axes. */
export function fastModeDescription(defaultModelId: string | undefined): string {
  const credits = codexTierCredits(defaultModelId, 'fast');
  if (credits !== null) {
    return `Runs Agent steps at ${CODEX_FAST_SPEED_MULTIPLIER}× model speed for ${credits}× ChatGPT credits per turn. API-key pricing differs.`;
  }

  const availability = defaultModelId
    ? 'The default model has no Fast tier.'
    : 'Applies only to supported OpenAI models.';
  return `${availability} Fast offers ${CODEX_FAST_SPEED_MULTIPLIER}× model speed with model-dependent ChatGPT credit use; API-key pricing differs.`;
}

/** Copy for the Flow-level Ultrafast switch; the cost lands on every step, with nobody watching. */
export function ultrafastDescription(credits: number | null): string {
  if (credits === null)
    return 'The default model has no Ultrafast tier, so steps run at standard speed.';
  return `Runs every Agent step up to ${CODEX_ULTRAFAST_SPEED_MULTIPLIER}× faster for ${credits}× ChatGPT credits per turn, even when nobody is watching. Pro 500 and eligible Enterprise/Edu plans only.`;
}

/** Flow-wide Codex speed: Fast, plus Ultrafast where the default model offers it (or it is already
 *  on, so it can be turned off). Turning one on replaces the other. */
export function FlowSpeedSettings({
  settings,
  onSettingsChange,
}: {
  settings: FlowSettings | undefined;
  onSettingsChange: (settings: FlowSettings) => void;
}): ReactElement {
  const modelId = settings?.defaultModel?.trim() || undefined;
  const speed = settings?.codexSpeed ?? 'standard';
  const ultrafastCredits = codexTierCredits(modelId, 'ultrafast');
  const toggle = (option: CodexSpeed) => (on: boolean) =>
    onSettingsChange(patch(settings, { codexSpeed: on ? option : undefined }));
  return (
    <>
      <SpeedRow
        id="flow-settings-codex-fast"
        label="Fast mode"
        description={fastModeDescription(modelId)}
        checked={speed === 'fast'}
        onCheckedChange={toggle('fast')}
      />
      {(ultrafastCredits !== null || speed === 'ultrafast') && (
        <SpeedRow
          id="flow-settings-codex-ultrafast"
          label="Ultrafast mode"
          description={ultrafastDescription(ultrafastCredits)}
          checked={speed === 'ultrafast'}
          onCheckedChange={toggle('ultrafast')}
        />
      )}
    </>
  );
}

function SpeedRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <Label htmlFor={id} className="text-xs font-medium">
          {label}
        </Label>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
