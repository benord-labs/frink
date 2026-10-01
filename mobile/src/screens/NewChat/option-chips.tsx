import { ActivityIndicator, Pressable, View } from 'react-native';
import {
  ArrowUp,
  ChevronDown,
  Folder,
  GitBranch,
  Hammer,
  Laptop,
  MapIcon,
  type LucideIcon,
} from 'lucide-react-native';
import type { NewChatPreferences } from '../../lib/preferences';
import { IconButton } from '../../ui/button';
import { Text } from '../../ui/text';
import { radius, space, useTheme } from '../../ui/theme';

function Chip({
  icon: Icon,
  label,
  accessibilityLabel,
  caret = false,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  accessibilityLabel: string;
  caret?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 36,
        maxWidth: 190,
        paddingLeft: space.md,
        paddingRight: caret ? space.sm + 2 : space.md,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: pressed ? t.pressed : 'transparent',
      })}
    >
      <Icon size={16} color={t.secondary} strokeWidth={2} />
      <Text variant="secondary" numberOfLines={1} style={{ fontWeight: '600', flexShrink: 1 }}>
        {label}
      </Text>
      {caret && <ChevronDown size={15} color={t.muted} strokeWidth={2.2} />}
    </Pressable>
  );
}

/** Project ▾ · Worktree/Local · Agent/Plan under the message, as in Codex. */
export function OptionChips({
  projectName,
  choice,
  onPickProject,
  onChange,
}: {
  projectName: string | undefined;
  choice: NewChatPreferences;
  onPickProject: () => void;
  onChange: (next: NewChatPreferences) => void;
}) {
  const local = !choice.useWorktree;
  const plan = choice.mode === 'plan';
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
      <Chip
        icon={Folder}
        label={projectName ?? 'Project'}
        accessibilityLabel={projectName ? `Project: ${projectName}` : 'Choose project'}
        caret
        onPress={onPickProject}
      />
      <Chip
        icon={local ? Laptop : GitBranch}
        label={local ? 'Local' : 'Worktree'}
        accessibilityLabel={`Work in: ${local ? 'Local' : 'Worktree'}`}
        onPress={() => onChange({ ...choice, useWorktree: local })}
      />
      <Chip
        icon={plan ? MapIcon : Hammer}
        label={plan ? 'Plan' : 'Agent'}
        accessibilityLabel={`Mode: ${plan ? 'Plan' : 'Agent'}`}
        onPress={() => onChange({ ...choice, mode: plan ? 'agent' : 'plan' })}
      />
    </View>
  );
}

/** The sheet's top-right send, where Mail puts it: always in reach above the keyboard. */
export function SendButton({
  enabled,
  sending,
  onPress,
}: {
  enabled: boolean;
  sending: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  if (sending)
    return (
      <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  return (
    <IconButton
      icon={ArrowUp}
      label="Start chat"
      tone="accent"
      size={32}
      disabled={!enabled}
      onPress={onPress}
    />
  );
}
