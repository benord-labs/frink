import { useState } from 'react';
import {
  EFFORT_LABEL,
  findPickerSelection,
  groupPickerModels,
  pickInWindow,
  type PickerFamily,
  type PickerWindow,
} from '@frink/shared/lib/model-picker-label/groups';
import type {
  MobileChatMode,
  MobileComposer,
  MobilePickerModel,
} from '@frink/shared/types/remote/mobile';
import { MenuChip } from './menu';
import { MODES, ModelSheet, modelLabel, selectedTier, type ComposerPatch } from './sheets';

export type { ComposerPatch } from './sheets';

const MORE = 'more';

type Family = PickerFamily<MobilePickerModel>;
type Selection = { family: Family; window: PickerWindow<MobilePickerModel> };
type Tier = ReturnType<typeof selectedTier>;

const familyName = (family: Family) =>
  modelLabel({ ...family.defaultWindow.defaultTier, detail: undefined });

/** Model and effort, inside the message box beside Attach. The rarer settings (context window,
 *  Thinking, speed, Auto, account) stay one tap further, in the sheet. */
export function ModelMenus({
  composer,
  disabled,
  onUpdate,
  onAccount,
}: {
  composer: MobileComposer;
  disabled: boolean;
  onUpdate: (patch: ComposerPatch) => void;
  onAccount?: (accountId: string) => void;
}) {
  const [sheet, setSheet] = useState(false);
  const families = groupPickerModels(composer.models);
  const current = findPickerSelection(families, composer.settings.modelId);
  const tier = current ? selectedTier(current.window, composer.settings.modelId) : undefined;
  return (
    <>
      <FamilyMenu
        families={families}
        current={current}
        tier={tier}
        title={composer.provider === 'claude' ? 'Claude' : 'Codex'}
        disabled={disabled}
        onUpdate={onUpdate}
        onMore={() => setSheet(true)}
      />
      {current && (
        <EffortMenu
          current={current}
          tier={tier}
          xhigh={composer.xhighSupported}
          disabled={disabled}
          onUpdate={onUpdate}
        />
      )}
      {sheet && (
        <ModelSheet
          composer={composer}
          onClose={() => setSheet(false)}
          onUpdate={onUpdate}
          onAccount={onAccount}
        />
      )}
    </>
  );
}

function FamilyMenu({
  families,
  current,
  tier,
  title,
  disabled,
  onUpdate,
  onMore,
}: {
  families: Family[];
  current: Selection | undefined;
  tier: Tier;
  title: string;
  disabled: boolean;
  onUpdate: (patch: ComposerPatch) => void;
  onMore: () => void;
}) {
  const model = current ? familyName(current.family) : 'Model';
  return (
    <MenuChip
      label={model}
      accessibilityLabel={`Model: ${model}`}
      disabled={disabled}
      groups={[
        {
          title,
          value: current?.family.key,
          options: families.map((family) => ({ id: family.key, label: familyName(family) })),
          onPick: (key) => {
            const family = families.find((candidate) => candidate.key === key);
            if (family)
              onUpdate({
                modelId: pickInWindow(family.defaultWindow, tier?.effort, Boolean(tier?.ultra)).id,
              });
          },
        },
        { options: [{ id: MORE, label: 'More settings…' }], onPick: onMore },
      ]}
    />
  );
}

function EffortMenu({
  current,
  tier,
  xhigh,
  disabled,
  onUpdate,
}: {
  current: Selection;
  tier: Tier;
  xhigh: boolean;
  disabled: boolean;
  onUpdate: (patch: ComposerPatch) => void;
}) {
  const efforts = current.window.tiers.filter(
    (candidate) => candidate.effort && (xhigh || candidate.effort !== 'xhigh'),
  );
  if (!tier?.effort || efforts.length < 2) return null;
  const effort = EFFORT_LABEL[tier.effort];
  return (
    <MenuChip
      label={effort}
      accessibilityLabel={`Effort: ${effort}`}
      disabled={disabled}
      groups={[
        {
          title: 'Effort',
          value: tier.effort,
          options: efforts.map((candidate) => ({
            id: candidate.effort!,
            label: EFFORT_LABEL[candidate.effort!],
          })),
          onPick: (id) => {
            const picked = efforts.find((candidate) => candidate.effort === id);
            if (picked)
              onUpdate({
                modelId: pickInWindow(current.window, picked.effort, Boolean(tier.ultra)).id,
              });
          },
        },
      ]}
    />
  );
}

/** How Frink works in this chat, in the quiet row under the message box. */
export function ModeMenu({
  mode,
  debugAvailable,
  disabled,
  onMode,
}: {
  mode: MobileChatMode;
  debugAvailable: boolean;
  disabled: boolean;
  onMode: (mode: MobileChatMode) => void;
}) {
  const modes = MODES.filter((candidate) => candidate.id !== 'debug' || debugAvailable);
  const label = modes.find((candidate) => candidate.id === mode)?.label ?? MODES[0].label;
  return (
    <MenuChip
      label={label}
      accessibilityLabel={`Mode: ${label}`}
      disabled={disabled}
      groups={[
        {
          title: 'Mode',
          value: mode,
          options: modes.map(({ id, label }) => ({ id, label })),
          onPick: (id) => onMode(id as MobileChatMode),
        },
      ]}
    />
  );
}
