import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  activityBackgroundTint,
  font,
  foregroundStyle,
  lineLimit,
  monospacedDigit,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import {
  createLiveActivity,
  type LiveActivityEnvironment,
  type LiveActivityLayout,
} from 'expo-widgets';
import type { MobileAgentCounts } from '@frink/shared/types/remote/mobile';

type Tint = Parameters<typeof foregroundStyle>[0];

/**
 * The Lock Screen card and Dynamic Island: how many chats are running and how many need you.
 * This function is serialized into the widget extension, so it may use only its arguments and
 * the imported views and modifiers (no module-scope helpers or constants).
 */
function FrinkStatus(
  { running, needsYou }: MobileAgentCounts,
  env: LiveActivityEnvironment,
): LiveActivityLayout {
  'widget';
  const primary = { type: 'hierarchical', style: 'primary' } as const;
  const secondary = { type: 'hierarchical', style: 'secondary' } as const;
  const waiting = needsYou > 0;
  // Tinted and vibrant presentations draw in one colour; a dimmed screen (Always-On) mutes accents.
  const accent = (): Tint => {
    if (env.isLuminanceReduced) return secondary;
    if (env.widgetRenderingMode === 'accented' || env.widgetRenderingMode === 'vibrant')
      return primary;
    return env.colorScheme === 'light' ? '#955104' : '#FCD573';
  };
  const amber = accent();

  const glyph = (name: 'arrow.triangle.2.circlepath' | 'hand.raised.fill', tint: Tint) => (
    <HStack modifiers={[foregroundStyle(tint)]}>
      <Image systemName={name} size={14} />
    </HStack>
  );
  const runningGlyph = glyph('arrow.triangle.2.circlepath', primary);
  const handGlyph = glyph('hand.raised.fill', amber);
  const label = (text: string, tint: Tint, size = 14) => (
    <Text
      modifiers={[
        font({ size, weight: 'semibold' }),
        monospacedDigit(),
        foregroundStyle(tint),
        lineLimit(1),
      ]}
    >
      {text}
    </Text>
  );
  // "3 running · 1 needs you", leaving out a zero; greyed out once the Mac has gone quiet.
  const summary = () => {
    const stale = env.isStale === true;
    return (
      <HStack spacing={6}>
        {running > 0 || !waiting ? label(`${running} running`, stale ? secondary : primary, 17) : null}
        {running > 0 && waiting ? label('·', secondary, 17) : null}
        {waiting ? label(`${needsYou} needs you`, stale ? secondary : amber, 17) : null}
        <Spacer />
      </HStack>
    );
  };
  const count = waiting ? label(String(needsYou), amber) : label(String(running), primary);

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={2}
        modifiers={[
          padding({ all: 16 }),
          // A clear tint shows iOS 26's glass; older systems keep the standard card.
          activityBackgroundTint(env.isLiquidGlassAvailable ? 'clear' : null),
        ]}
      >
        <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(secondary)]}>
          Frink
        </Text>
        {summary()}
        {env.isStale ? (
          <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary)]}>
            May be out of date
          </Text>
        ) : null}
      </VStack>
    ),
    compactLeading: waiting ? handGlyph : runningGlyph,
    compactTrailing: count,
    minimal: count,
    expandedLeading: (
      <HStack spacing={6} modifiers={[padding({ leading: 4 })]}>
        {runningGlyph}
        {label(`${running} running`, primary)}
      </HStack>
    ),
    expandedTrailing: waiting ? (
      <HStack spacing={6} modifiers={[padding({ trailing: 4 })]}>
        {handGlyph}
        {label(`${needsYou} needs you`, amber)}
      </HStack>
    ) : null,
  };
}

export default createLiveActivity<MobileAgentCounts>('FrinkStatus', FrinkStatus);
