import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, View } from 'react-native';
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleQuestionMark,
  CircleSlash,
  Clock,
  Hourglass,
  LoaderCircle,
  MessageSquare,
  Workflow,
  type LucideIcon,
} from 'lucide-react-native';
import type { StatusGlyph as GlyphName, StatusTone } from '../lib/status';
import { radius, useTheme, type Theme } from './theme';

const GLYPHS: Record<GlyphName, LucideIcon> = {
  never: Circle,
  live: LoaderCircle,
  queued: Clock,
  paused: CirclePause,
  done: CircleCheck,
  cancelled: CircleSlash,
  awaiting: CircleQuestionMark,
  failed: CircleAlert,
  background: Hourglass,
};

export function toneColor(t: Theme, tone: StatusTone): string {
  return {
    quiet: t.muted,
    live: t.live,
    accent: t.accent,
    attention: t.attention,
    danger: t.danger,
  }[tone];
}

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => mounted && setReduce(value));
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

/** Loops a 0→1 value forever; still under Reduce Motion. */
function useLoop(duration: number, active: boolean) {
  const value = useRef(new Animated.Value(0)).current;
  const reduce = useReduceMotion();
  useEffect(() => {
    if (!active || reduce) return;
    const loop = Animated.loop(
      Animated.timing(value, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, duration, reduce, value]);
  return value;
}

/** A state's shape-coded glyph; the live glyph spins, as on desktop. */
export function StatusGlyph({
  glyph,
  tone,
  size = 18,
}: {
  glyph: GlyphName;
  tone: StatusTone;
  size?: number;
}) {
  const t = useTheme();
  const Icon = GLYPHS[glyph];
  const spin = useLoop(1500, glyph === 'live');
  const icon = <Icon size={size} color={toneColor(t, tone)} strokeWidth={2} />;
  if (glyph !== 'live') return icon;
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View style={{ transform: [{ rotate }] }}>{icon}</Animated.View>;
}

/** The running marker: a primary dot with a breathing ring. */
export function PulseDot({ color, size = 8 }: { color: string; size?: number }) {
  const pulse = useLoop(1600, true);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity,
          transform: [{ scale }],
        }}
      />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

/** What a row is, by shape: a chat bubble or a Flow graph. Colour stays for state. */
export function KindTile({
  kind,
  pulse,
  size = 38,
}: {
  kind: 'chat' | 'flow';
  /** Running marker colour: the caller's surface decides (primary on Chats, green on Queue). */
  pulse?: string;
  size?: number;
}) {
  const t = useTheme();
  const Icon = kind === 'flow' ? Workflow : MessageSquare;
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius.md,
          backgroundColor: t.fill,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon size={size * 0.47} color={t.secondary} strokeWidth={1.9} />
      </View>
      {pulse && (
        <View
          style={{
            position: 'absolute',
            right: -3,
            bottom: -3,
            padding: 3,
            borderRadius: 8,
            backgroundColor: t.background,
          }}
        >
          <PulseDot color={pulse} />
        </View>
      )}
    </View>
  );
}
