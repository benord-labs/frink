import type { ReactNode } from 'react';
import { View } from 'react-native';
import {
  Bug,
  CircleUser,
  Code,
  Hammer,
  Lightbulb,
  Map as MapIcon,
  Rocket,
  ShieldCheck,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react-native';
import {
  EFFORT_LABEL,
  findPickerSelection,
  groupPickerModels,
  pickInWindow,
} from '@frink/shared/lib/model-picker-label/groups';
import {
  CODEX_FAST_SPEED_MULTIPLIER,
  CODEX_ULTRAFAST_SPEED_MULTIPLIER,
} from '@frink/shared/lib/codex-cli-models';
import type { CodexSpeed } from '@frink/shared/types/execution';
import type {
  MobileChatMode,
  MobileComposer,
  MobilePickerModel,
} from '@frink/shared/types/remote/mobile';
import { Segmented } from '../../../ui/segmented';
import { GUTTER } from '../../../ui/theme';
import { OptionRow, Sheet, SheetSection, SwitchRow } from './sheet';

export type ComposerPatch = Partial<{
  modelId: string;
  autoMode: boolean;
  codexSpeed: CodexSpeed;
  thinkingEnabled: boolean;
}>;

// Same words and order as the desktop mode menu.
export const MODES: Array<{ id: MobileChatMode; label: string; detail: string; icon: LucideIcon }> =
  [
    { id: 'agent', label: 'Agent', detail: 'Makes changes directly', icon: Hammer },
    { id: 'plan', label: 'Plan', detail: 'Writes a plan for you to approve first', icon: MapIcon },
    { id: 'debug', label: 'Debug', detail: 'Tracks down a bug step by step', icon: Bug },
  ];

/** The desktop trigger's label rule: name, version, then a non-default tier. */
export function modelLabel(model: MobilePickerModel | undefined): string {
  if (!model) return 'Model';
  let name = model.name;
  if (model.version && !model.name.includes(model.version)) name += ` ${model.version}`;
  return model.detail && model.detail !== 'Medium' ? `${name} · ${model.detail}` : name;
}

function Padded({ children }: { children: ReactNode }) {
  return <View style={{ paddingHorizontal: GUTTER }}>{children}</View>;
}

/** Family, context window, effort, the switches and the account: every model setting lives here,
 *  so the composer itself keeps two chips. */
export function ModelSheet({
  composer,
  onClose,
  onUpdate,
  onAccount,
}: {
  composer: MobileComposer;
  onClose: () => void;
  onUpdate: (patch: ComposerPatch) => void;
  onAccount: (accountId: string) => void;
}) {
  const families = groupPickerModels(composer.models);
  const current = findPickerSelection(families, composer.settings.modelId);
  const selected = current?.window.tiers.find((tier) => tier.id === composer.settings.modelId);
  const claude = composer.provider === 'claude';
  // Effort only reaches Claude while Thinking is on; the desktop slider goes inert the same way.
  const effortInert = claude && !composer.settings.thinkingEnabled;
  const tiers = (current?.window.tiers ?? []).filter(
    (tier) => composer.xhighSupported || tier.effort !== 'xhigh',
  );
  return (
    <Sheet title="Model" onClose={onClose}>
      <SheetSection title={claude ? 'Claude' : 'Codex'}>
        {families.map((family, index) => (
          <OptionRow
            key={family.key}
            icon={Sparkles}
            title={modelLabel({ ...family.defaultWindow.defaultTier, detail: undefined })}
            subtitle={family.defaultWindow.defaultTier.contextLabel}
            selected={family.key === current?.family.key}
            separator={index < families.length - 1}
            onPress={() =>
              onUpdate({ modelId: pickInWindow(family.defaultWindow, selected?.effort).id })
            }
          />
        ))}
      </SheetSection>
      {current && current.family.windows.length > 1 && (
        <SheetSection title="Context">
          <Padded>
            <Segmented
              items={current.family.windows.map((window) => ({
                id: window.label || 'default',
                label: window.label || 'Standard',
              }))}
              value={current.window.label || 'default'}
              onChange={(label) => {
                const window = current.family.windows.find((w) => (w.label || 'default') === label);
                if (window) onUpdate({ modelId: pickInWindow(window, selected?.effort).id });
              }}
            />
          </Padded>
        </SheetSection>
      )}
      {tiers.length > 1 && (
        <SheetSection
          title="Effort"
          footer={effortInert ? 'Effort applies while Thinking is on.' : undefined}
        >
          <Padded>
            <Segmented
              items={tiers.map((tier) => ({
                id: tier.id,
                label: tier.effort ? EFFORT_LABEL[tier.effort] : tier.name,
              }))}
              value={selected?.id ?? tiers[0].id}
              onChange={(id) => onUpdate({ modelId: id })}
            />
          </Padded>
        </SheetSection>
      )}
      <SheetSection>
        {claude ? (
          <SwitchRow
            icon={Lightbulb}
            label="Thinking"
            detail="Deeper reasoning. Applies to every chat."
            value={composer.settings.thinkingEnabled}
            onChange={(thinkingEnabled) => onUpdate({ thinkingEnabled })}
          />
        ) : (
          <SpeedRows composer={composer} onUpdate={onUpdate} />
        )}
        <SwitchRow
          icon={ShieldCheck}
          label="Auto Mode"
          detail={composer.autoUnavailableReason || 'Approves routine steps instead of asking you.'}
          value={!composer.autoUnavailableReason && composer.settings.autoMode}
          disabled={!!composer.autoUnavailableReason}
          onChange={(autoMode) => onUpdate({ autoMode })}
        />
      </SheetSection>
      {composer.accounts.length > 0 && <AccountSection composer={composer} onAccount={onAccount} />}
    </Sheet>
  );
}

export function ModeSheet({
  composer,
  onClose,
  onMode,
}: {
  composer: MobileComposer;
  onClose: () => void;
  onMode: (mode: MobileChatMode) => void;
}) {
  const modes = MODES.filter((mode) => mode.id !== 'debug' || composer.debugAvailable);
  return (
    <Sheet title="Mode" onClose={onClose}>
      <SheetSection title="How Frink works in this chat">
        {modes.map((mode, index) => (
          <OptionRow
            key={mode.id}
            icon={mode.icon}
            title={mode.label}
            subtitle={mode.detail}
            selected={composer.mode === mode.id}
            separator={index < modes.length - 1}
            onPress={() => {
              onMode(mode.id);
              onClose();
            }}
          />
        ))}
      </SheetSection>
    </Sheet>
  );
}

/** Which signed-in account answers. Switching can change the provider, and with it the models above. */
function AccountSection({
  composer,
  onAccount,
}: {
  composer: MobileComposer;
  onAccount: (accountId: string) => void;
}) {
  return (
    <SheetSection
      title="Account"
      footer={
        composer.projectId
          ? 'Applies to every chat in this project, on your Mac too.'
          : 'This chat has no project, so this changes your default account.'
      }
    >
      {composer.accounts.map((account, index) => (
        <OptionRow
          key={account.id}
          icon={account.type === 'codex' ? Code : CircleUser}
          title={account.label}
          subtitle={
            account.isAuthenticated
              ? account.type === 'codex'
                ? 'Codex'
                : 'Claude'
              : 'Sign in again on your Mac to use this account'
          }
          dimmed={!account.isAuthenticated}
          selected={composer.account?.id === account.id}
          separator={index < composer.accounts.length - 1}
          onPress={account.isAuthenticated ? () => onAccount(account.id) : undefined}
        />
      ))}
    </SheetSection>
  );
}

/** Codex's paid speeds, like the desktop picker: turning one on replaces the other, and each shows
 *  its credit cost. Ultrafast appears only on a model that offers it. */
function SpeedRows({
  composer,
  onUpdate,
}: {
  composer: MobileComposer;
  onUpdate: (patch: ComposerPatch) => void;
}) {
  const { fast, ultrafast } = composer.codexSpeedCredits;
  const speed = composer.settings.codexSpeed;
  const toggle = (option: CodexSpeed) => (on: boolean) =>
    onUpdate({ codexSpeed: on ? option : 'standard' });
  return (
    <>
      <SwitchRow
        icon={Zap}
        label="Fast"
        detail={
          fast === null
            ? 'Not available for this model.'
            : `${CODEX_FAST_SPEED_MULTIPLIER}× faster. Uses ${fast}× credits.`
        }
        value={speed === 'fast' && fast !== null}
        disabled={fast === null}
        onChange={toggle('fast')}
      />
      {ultrafast !== null && (
        <SwitchRow
          icon={Rocket}
          label="Ultrafast"
          detail={`Up to ${CODEX_ULTRAFAST_SPEED_MULTIPLIER}× faster. Uses ${ultrafast}× credits.`}
          value={speed === 'ultrafast'}
          onChange={toggle('ultrafast')}
        />
      )}
    </>
  );
}
