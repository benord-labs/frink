import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronDown, Sparkles, type LucideIcon } from 'lucide-react-native';
import type { MobileChatMode, MobileComposer } from '@frink/shared/types/remote/mobile';
import { Text } from '../../../ui/text';
import { radius, space, useTheme } from '../../../ui/theme';
import { MODES, ModeSheet, ModelSheet, modelLabel, type ComposerPatch } from './sheets';

export type { ComposerPatch } from './sheets';

/** A compact pill that opens the sheet for one choice. */
function Chip({
  icon: Icon,
  label,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled: boolean;
  accessibilityLabel: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => ({
        height: 30,
        flexShrink: 1,
        minWidth: 0,
        paddingHorizontal: 10,
        borderRadius: radius.pill,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: t.fill,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Icon size={14} color={t.secondary} strokeWidth={2.1} />
      <Text
        variant="secondary"
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
        style={{ flexShrink: 1, fontWeight: '500' }}
      >
        {label}
      </Text>
      <ChevronDown size={13} color={t.muted} strokeWidth={2.2} />
    </Pressable>
  );
}

/** The model chip names the one switch that changes how it answers: Thinking, or Codex's Fast. */
function modelChipLabel(composer: MobileComposer): string {
  const name = modelLabel(composer.models.find((m) => m.id === composer.settings.modelId));
  if (composer.provider === 'claude' && composer.settings.thinkingEnabled)
    return `${name} · Thinking`;
  if (composer.provider === 'codex' && composer.settings.codexFastMode) return `${name} · Fast`;
  return name;
}

/** Two chips above the message box: how Frink works (mode) and what answers (model, with its
 *  switches and account in the sheet). Changes are saved on the computer, so the desktop follows. */
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
  const [open, setOpen] = useState<'mode' | 'model' | null>(null);
  const mode = MODES.find((candidate) => candidate.id === composer.mode) ?? MODES[0];
  const model = modelChipLabel(composer);
  const close = () => setOpen(null);
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      <Chip
        icon={mode.icon}
        label={mode.label}
        disabled={disabled}
        accessibilityLabel={`Mode: ${mode.label}`}
        onPress={() => setOpen('mode')}
      />
      <Chip
        icon={Sparkles}
        label={model}
        disabled={disabled}
        accessibilityLabel={`Model: ${model}`}
        onPress={() => setOpen('model')}
      />
      {open === 'mode' && <ModeSheet composer={composer} onClose={close} onMode={onMode} />}
      {open === 'model' && (
        <ModelSheet composer={composer} onClose={close} onUpdate={onUpdate} onAccount={onAccount} />
      )}
    </View>
  );
}
