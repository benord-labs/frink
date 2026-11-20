import { Button, Host, HStack, Image, Label, Menu, Section, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as labelled,
  disabled as inert,
  font,
  foregroundStyle,
  lineLimit,
} from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../../../ui/theme';
import type { MenuChipProps } from './menu';

/** A word and a caret that open the system's own pull-down menu, with a tick on the current choice. */
export function MenuChip({ label, accessibilityLabel, groups, disabled = false }: MenuChipProps) {
  const t = useTheme();
  return (
    // The page already lifts the row above the keyboard; the host must not lift its label again.
    <Host
      matchContents
      ignoreSafeArea="keyboard"
      colorScheme={t.dark ? 'dark' : 'light'}
      style={{ flexShrink: 1 }}
    >
      <Menu
        modifiers={[labelled(accessibilityLabel), inert(disabled)]}
        label={
          <HStack spacing={4}>
            <Text
              modifiers={[
                font({ size: 14, weight: 'medium' }),
                foregroundStyle(t.secondary),
                lineLimit(1),
              ]}
            >
              {label}
            </Text>
            <Image systemName="chevron.down" size={10} color={t.muted} />
          </HStack>
        }
      >
        {groups.map((group, index) => (
          <Section key={group.title ?? index} title={group.title}>
            {group.options.map((option) => {
              const check = option.id === group.value ? 'checkmark' : undefined;
              const pick = () => option.id !== group.value && group.onPick(option.id);
              // A second Text in a menu button's label is drawn as the system subtitle.
              return option.detail ? (
                <Button key={option.id} onPress={pick}>
                  <Label title={option.label} systemImage={check} />
                  <Text>{option.detail}</Text>
                </Button>
              ) : (
                <Button key={option.id} label={option.label} systemImage={check} onPress={pick} />
              );
            })}
          </Section>
        ))}
      </Menu>
    </Host>
  );
}
