import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  activityBackgroundTint,
  background,
  clipShape,
  contentTransition,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  padding,
  resizable,
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
  const stale = env.isStale === true;
  // Whichever state leads: what needs you, else what is running, else nothing.
  const pick = <T,>(needs: T, busy: T, idle: T) =>
    needsYou > 0 ? needs : running > 0 ? busy : idle;
  // Colour is for state only, matching the Queue the card opens: running is live green and
  // needs you is attention amber (mobile/src/ui/theme.ts). Tinted and vibrant presentations draw
  // in one colour, and a dimmed screen (Always-On) or a stale card mutes them.
  const state = (dark: string, light: string): Tint => {
    if (stale || env.isLuminanceReduced) return secondary;
    if (env.widgetRenderingMode === 'accented' || env.widgetRenderingMode === 'vibrant')
      return primary;
    return env.colorScheme === 'light' ? light : dark;
  };
  const green = state('#86EFAC', '#1B6A35');
  const amber = state('#FCD573', '#955104');
  const lead = pick(amber, green, primary);

  // The F mark is a template image, so it takes the tint of its frame (0.57 wide per 1 tall).
  const mark = (height: number, tint: Tint) => (
    <HStack modifiers={[frame({ width: height * 0.57, height }), foregroundStyle(tint)]}>
      <Image assetName="FrinkMark" modifiers={[resizable()]} />
    </HStack>
  );
  const text = (value: string, size: number, tint: Tint, weight: 'medium' | 'semibold') => (
    <Text modifiers={[font({ size, weight }), foregroundStyle(tint), lineLimit(1)]}>{value}</Text>
  );
  const number = (value: number, size: number, tint: Tint) => (
    <Text
      modifiers={[
        font({ size, weight: 'semibold', design: 'rounded' }),
        monospacedDigit(),
        contentTransition('numericText'),
        foregroundStyle(tint),
      ]}
    >
      {value}
    </Text>
  );
  const brand = (
    <HStack spacing={6}>
      {mark(16, primary)}
      {text('Frink', 14, primary, 'semibold')}
    </HStack>
  );
  // The app icon as iOS draws it beside notifications: the violet F on a black rounded tile.
  const appIcon = (
    <HStack
      modifiers={[
        frame({ width: 38, height: 38 }),
        background('#000000'),
        clipShape('roundedRectangle', 9),
      ]}
    >
      {mark(24, '#A78BFA')}
    </HStack>
  );
  // A zero stays in place but goes grey, so the card never reflows as work starts and stops.
  const stat = (value: number, label: string, tint: Tint) => (
    <VStack alignment="trailing" spacing={0}>
      {number(value, 28, value > 0 ? tint : secondary)}
      {text(label, 12, secondary, 'medium')}
    </VStack>
  );
  const stats = (
    <HStack spacing={18}>
      {stat(running, 'running', green)}
      {stat(needsYou, needsYou === 1 ? 'needs you' : 'need you', amber)}
    </HStack>
  );
  // 0/0 can follow a failure as well as a success, so it is never shown as "done".
  const status = text(
    stale
      ? 'May be out of date'
      : pick('Waiting for you', 'Working on your Mac', 'Nothing running'),
    14,
    secondary,
    'medium',
  );
  const count = pick(number(needsYou, 14, amber), number(running, 14, green), null);

  return {
    banner: (
      <HStack
        spacing={12}
        modifiers={[
          padding({ all: 14 }),
          // A clear tint shows iOS 26's glass; StandBy and older systems keep the standard card.
          activityBackgroundTint(
            env.isLiquidGlassAvailable && !env.isActivityFullscreen ? 'clear' : null,
          ),
        ]}
      >
        <HStack spacing={10}>
          {appIcon}
          <VStack alignment="leading" spacing={2}>
            {text('Frink', 15, primary, 'semibold')}
            {status}
          </VStack>
        </HStack>
        <Spacer />
        {stats}
      </HStack>
    ),
    bannerSmall: (
      <HStack spacing={8} modifiers={[padding({ all: 12 })]}>
        {mark(16, lead)}
        {count}
        <Spacer />
      </HStack>
    ),
    // The two halves read as one unit: the mark and the count share the leading state's colour.
    compactLeading: mark(14, lead),
    compactTrailing: count,
    minimal: count ?? mark(14, primary),
    expandedLeading: <HStack modifiers={[padding({ leading: 6, top: 6 })]}>{brand}</HStack>,
    expandedTrailing: <HStack modifiers={[padding({ trailing: 6 })]}>{stats}</HStack>,
    expandedBottom: (
      <HStack modifiers={[padding({ leading: 6, trailing: 6 })]}>
        {status}
        <Spacer />
      </HStack>
    ),
  };
}

export default createLiveActivity<MobileAgentCounts>('FrinkStatus', FrinkStatus);
