import { View } from 'react-native';
import { Text } from '../../../ui/text';
import { space, useTheme } from '../../../ui/theme';

const STEPS = [
  {
    title: 'Turn on Tailscale on both devices',
    detail: 'It keeps the link between your iPhone and Mac private.',
  },
  {
    title: 'Make a code on your Mac',
    detail:
      'In Frink, open Settings → Mobile, turn on mobile access and follow the steps there, then choose Create pairing code.',
  },
  { title: 'Scan the code', detail: 'Each code works once, for five minutes.' },
];
const NODE = 28;

/** How pairing works, as numbered nodes joined by a thin rail. */
export function Checklist() {
  const t = useTheme();
  return (
    <View accessibilityRole="list">
      {STEPS.map((step, index) => (
        <View key={step.title} style={{ flexDirection: 'row', gap: space.lg }}>
          <View style={{ alignItems: 'center', width: NODE }}>
            <View
              style={{
                width: NODE,
                height: NODE,
                borderRadius: NODE / 2,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.background,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text variant="label" color="secondary">
                {index + 1}
              </Text>
            </View>
            {index < STEPS.length - 1 && (
              <View
                style={{ flex: 1, width: 1, backgroundColor: t.border, marginVertical: space.xs }}
              />
            )}
          </View>
          <View
            accessibilityRole="text"
            style={{
              flex: 1,
              gap: 2,
              paddingTop: 3,
              paddingBottom: index < STEPS.length - 1 ? space.xl : 0,
            }}
          >
            <Text variant="row">{step.title}</Text>
            <Text variant="secondary" color="muted">
              {step.detail}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}
