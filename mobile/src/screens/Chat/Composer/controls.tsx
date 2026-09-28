import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import {
  EFFORT_LABEL,
  findPickerSelection,
  groupPickerModels,
  pickInWindow,
} from '../../../../../src/shared/lib/model-picker-label/groups';
import type {
  MobileChatMode,
  MobileComposer,
  MobilePickerModel,
} from '../../../../../src/shared/types/remote/mobile';
import { Card, Icon, Label, Notice, Row, Section, type IconName } from '../../../ui/primitives';
import { Segmented } from '../../../ui/segmented';
import { useTheme } from '../../../ui/theme';
import { Sheet } from './sheet';

export type ComposerPatch = Partial<{
  modelId: string;
  autoMode: boolean;
  codexFastMode: boolean;
  thinkingEnabled: boolean;
}>;

// Same words and order as the desktop mode menu.
const MODES: Array<{ id: MobileChatMode; label: string; detail: string; icon: IconName }> = [
  {
    id: 'agent',
    label: 'Agent',
    detail: 'Apply changes directly without a plan',
    icon: 'hammer-outline',
  },
  { id: 'plan', label: 'Plan', detail: 'Create a plan before making changes', icon: 'map-outline' },
  {
    id: 'debug',
    label: 'Debug',
    detail: 'Hypothesis-driven debugging with instrumentation',
    icon: 'construct-outline',
  },
];

/** The desktop trigger's label rule: name, version, then a non-default tier. */
// Reason: Each optional label segment is one guarded branch, mirroring the desktop rule.
// fallow-ignore-next-line complexity
export function modelLabel(model: MobilePickerModel | undefined): string {
  if (!model) return 'Model';
  let name = model.name;
  if (model.version && !model.name.includes(model.version)) name += ` ${model.version}`;
  return model.detail && model.detail !== 'Medium' ? `${name} · ${model.detail}` : name;
}

// Reason: Toggle and menu chips share one pill so the row reads as one control strip.
// fallow-ignore-next-line complexity
function Chip({
  icon,
  label,
  onPress,
  on,
  menu = false,
  disabled = false,
  accessibilityLabel,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  on?: boolean;
  menu?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const toggle = on !== undefined;
  const active = toggle && on && !disabled;
  return (
    <Pressable
      accessibilityRole={toggle ? 'switch' : 'button'}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, ...(toggle ? { checked: on } : {}) }}
      aria-checked={toggle ? on : undefined}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      // Reason: On, disabled and pressed states combine into one pill style.
      // fallow-ignore-next-line complexity
      style={({ pressed }) => ({
        height: 32,
        paddingHorizontal: 11,
        borderRadius: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: active ? t.accentSoft : t.fill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: active ? t.accent : t.border,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={15} color={active ? t.accent : t.secondary} />
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.4}
        style={{
          maxWidth: 180,
          fontSize: 14,
          lineHeight: 18,
          fontWeight: '500',
          color: active ? t.accent : t.text,
        }}
      >
        {label}
      </Text>
      {menu && <Icon name="chevron-down" size={12} color={t.muted} />}
    </Pressable>
  );
}

function SwitchRow({
  label,
  detail,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  detail: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Label size={16} style={{ fontWeight: '500' }}>
          {label}
        </Label>
        <Label muted size={14}>
          {detail}
        </Label>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        trackColor={{ true: t.accent, false: t.raised }}
        thumbColor="#FFFFFF"
        {...(Platform.OS === 'web' ? { activeThumbColor: '#FFFFFF' } : {})}
        onValueChange={onChange}
      />
    </View>
  );
}

// Reason: Family, context window, effort and the provider switch are one model picker, as on desktop.
// fallow-ignore-next-line complexity
function ModelSheet({
  composer,
  onClose,
  onUpdate,
}: {
  composer: MobileComposer;
  onClose: () => void;
  onUpdate: (patch: ComposerPatch) => void;
}) {
  const families = groupPickerModels(composer.models);
  const current = findPickerSelection(families, composer.settings.modelId);
  const selected = current?.window.tiers.find((tier) => tier.id === composer.settings.modelId);
  const claude = composer.provider === 'claude';
  // Effort only reaches Claude while Thinking is on — the desktop slider goes inert the same way.
  const effortInert = claude && !composer.settings.thinkingEnabled;
  const tiers = (current?.window.tiers ?? []).filter(
    (tier) => composer.xhighSupported || tier.effort !== 'xhigh',
  );
  return (
    <Sheet visible title="Model" onClose={onClose}>
      <Section title={claude ? 'Claude' : 'Codex'}>
        {families.map((family, index) => (
          <Row
            key={family.key}
            title={modelLabel({ ...family.defaultWindow.defaultTier, detail: undefined })}
            icon="sparkles-outline"
            selected={family.key === current?.family.key}
            separator={index < families.length - 1}
            onPress={() =>
              onUpdate({ modelId: pickInWindow(family.defaultWindow, selected?.effort).id })
            }
          />
        ))}
      </Section>
      {current && current.family.windows.length > 1 && (
        <Section title="Context" plain>
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
        </Section>
      )}
      {tiers.length > 1 && (
        <Section title="Effort" plain>
          <Segmented
            items={tiers.map((tier) => ({
              id: tier.id,
              label: tier.effort ? EFFORT_LABEL[tier.effort] : tier.name,
            }))}
            value={selected?.id ?? tiers[0].id}
            onChange={(id) => onUpdate({ modelId: id })}
          />
          {effortInert && <Notice>Effort applies while Thinking is on.</Notice>}
        </Section>
      )}
      <Card>
        {claude ? (
          <SwitchRow
            label="Thinking"
            detail="Deeper reasoning. Applies to every chat."
            value={composer.settings.thinkingEnabled}
            onChange={(thinkingEnabled) => onUpdate({ thinkingEnabled })}
          />
        ) : (
          <SwitchRow
            label="Fast"
            detail={
              composer.codexFastCredits === null
                ? 'Not available for this model.'
                : `Priority speed. Uses ${composer.codexFastCredits}× credits.`
            }
            value={composer.settings.codexFastMode && composer.codexFastCredits !== null}
            disabled={composer.codexFastCredits === null}
            onChange={(codexFastMode) => onUpdate({ codexFastMode })}
          />
        )}
      </Card>
    </Sheet>
  );
}

function ModeSheet({
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
    <Sheet visible title="Mode" onClose={onClose}>
      <Section title="This conversation">
        {modes.map((mode, index) => (
          <Row
            key={mode.id}
            title={mode.label}
            subtitle={mode.detail}
            icon={mode.icon}
            selected={composer.mode === mode.id}
            separator={index < modes.length - 1}
            onPress={() => {
              onMode(mode.id);
              onClose();
            }}
          />
        ))}
      </Section>
    </Sheet>
  );
}

// Reason: Provider and sign-in state decide the subtitle, icon and whether the row is pickable.
// fallow-ignore-next-line complexity
function AccountRow({
  account,
  selected,
  separator,
  onPick,
}: {
  account: MobileComposer['accounts'][number];
  selected: boolean;
  separator: boolean;
  onPick: () => void;
}) {
  const codex = account.type === 'codex';
  return (
    <Row
      title={account.label}
      subtitle={
        account.isAuthenticated
          ? codex
            ? 'Codex'
            : 'Claude'
          : 'Reconnect this account on your computer'
      }
      icon={codex ? 'code-slash-outline' : 'sparkles-outline'}
      dimmed={!account.isAuthenticated}
      selected={selected}
      separator={separator}
      onPress={account.isAuthenticated ? onPick : undefined}
    />
  );
}

function AccountSheet({
  composer,
  onClose,
  onAccount,
}: {
  composer: MobileComposer;
  onClose: () => void;
  onAccount: (accountId: string) => void;
}) {
  return (
    <Sheet visible title="Account" onClose={onClose}>
      <Notice>
        {composer.projectId
          ? 'Applies to every chat in this project, on your computer too.'
          : 'This chat has no project, so this changes your default account.'}
      </Notice>
      <Section title="Accounts">
        {composer.accounts.map((account, index) => (
          <AccountRow
            key={account.id}
            account={account}
            selected={composer.account?.id === account.id}
            separator={index < composer.accounts.length - 1}
            onPick={() => {
              onAccount(account.id);
              onClose();
            }}
          />
        ))}
      </Section>
    </Sheet>
  );
}

type OpenSheet = 'mode' | 'model' | 'account' | null;

/** The desktop composer's controls as a chip strip: mode, model and effort, Auto, Thinking or
 *  Fast, and the account. Changes are saved on the computer, so the desktop follows live. */
// Reason: The strip renders each control's state and its sheet from one composer snapshot.
// fallow-ignore-next-line complexity
export function ComposerControls({
  composer,
  disabled,
  onUpdate,
  onMode,
  onAccount,
}: {
  composer: MobileComposer;
  disabled: boolean;
  onUpdate: (patch: ComposerPatch) => void;
  onMode: (mode: MobileChatMode) => void;
  onAccount: (accountId: string) => void;
}) {
  const [open, setOpen] = useState<OpenSheet>(null);
  const [autoReason, setAutoReason] = useState(false);
  const mode = MODES.find((candidate) => candidate.id === composer.mode) ?? MODES[0];
  const model = composer.models.find((m) => m.id === composer.settings.modelId);
  const autoAvailable = !composer.autoUnavailableReason;
  const claude = composer.provider === 'claude';
  return (
    <View style={{ gap: 8 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 6, paddingHorizontal: 4 }}
      >
        <Chip
          icon={mode.icon}
          label={mode.label}
          menu
          disabled={disabled}
          accessibilityLabel={`Mode: ${mode.label}`}
          onPress={() => setOpen('mode')}
        />
        <Chip
          icon="sparkles-outline"
          label={modelLabel(model)}
          menu
          disabled={disabled}
          accessibilityLabel={`Model: ${modelLabel(model)}`}
          onPress={() => setOpen('model')}
        />
        <Chip
          icon="shield-checkmark-outline"
          label="Auto"
          on={autoAvailable && composer.settings.autoMode}
          disabled={disabled}
          onPress={() =>
            autoAvailable
              ? onUpdate({ autoMode: !composer.settings.autoMode })
              : setAutoReason((shown) => !shown)
          }
        />
        {claude ? (
          <Chip
            icon="bulb-outline"
            label="Thinking"
            on={composer.settings.thinkingEnabled}
            disabled={disabled}
            onPress={() => onUpdate({ thinkingEnabled: !composer.settings.thinkingEnabled })}
          />
        ) : (
          composer.codexFastCredits !== null && (
            <Chip
              icon="flash-outline"
              label="Fast"
              on={composer.settings.codexFastMode}
              disabled={disabled}
              onPress={() => onUpdate({ codexFastMode: !composer.settings.codexFastMode })}
            />
          )
        )}
        {composer.accounts.length > 0 && (
          <Chip
            icon="person-circle-outline"
            label={composer.account?.label ?? 'Account'}
            menu
            disabled={disabled}
            accessibilityLabel={`Account: ${composer.account?.label ?? 'none'}`}
            onPress={() => setOpen('account')}
          />
        )}
      </ScrollView>
      {autoReason && !autoAvailable && <Notice>{composer.autoUnavailableReason}</Notice>}
      {open === 'mode' && (
        <ModeSheet composer={composer} onClose={() => setOpen(null)} onMode={onMode} />
      )}
      {open === 'model' && (
        <ModelSheet composer={composer} onClose={() => setOpen(null)} onUpdate={onUpdate} />
      )}
      {open === 'account' && (
        <AccountSheet composer={composer} onClose={() => setOpen(null)} onAccount={onAccount} />
      )}
    </View>
  );
}
