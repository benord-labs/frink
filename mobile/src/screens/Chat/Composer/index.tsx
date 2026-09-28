import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Button, GUTTER, Icon, Notice, bareInput } from '../../../ui/primitives';
import { useTheme } from '../../../ui/theme';
import { glassStyle } from '../../../ui/material';

// Pill geometry: a 22pt text line with 12pt above and below makes a 46pt pill. The 32pt action
// keeps a 7pt margin, so it shares the centre of a single line and stays on the last line as text grows.
const LINE = 22;
const PAD = 12;
const ACTION = 32;
const MAX_LINES = 6;
// iOS scales lineHeight with Dynamic Type, so every height derived from LINE scales with it too.
const MAX_FONT_SCALE = 1.6;

function useLine() {
  const { fontScale } = useWindowDimensions();
  return Math.round(LINE * Math.min(Math.max(fontScale, 1), MAX_FONT_SCALE));
}

// Reason: Send, stop, busy and disabled share one 32pt control.
// fallow-ignore-next-line complexity
function ComposerAction({
  label,
  icon,
  enabled,
  busy = false,
  onPress,
}: {
  label: string;
  icon: 'arrow-up' | 'stop';
  enabled: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const line = useLine();
  const stop = icon === 'stop';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: ACTION,
        height: ACTION,
        margin: (line + PAD * 2 - ACTION) / 2,
        borderRadius: ACTION / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: enabled ? (stop ? t.text : t.accent) : t.fill,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={t.muted} />
      ) : (
        <Icon
          name={icon}
          size={stop ? 12 : 18}
          color={enabled ? (stop ? t.background : t.onAccent) : t.muted}
        />
      )}
    </Pressable>
  );
}

// Reason: Idle, sending, working and stop-confirmation states share one fixed composer frame.
// fallow-ignore-next-line complexity
export function Composer({
  active,
  busy,
  value,
  onChange,
  onSend,
  confirmStop,
  setConfirmStop,
  onStop,
}: {
  active: boolean;
  busy: boolean;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  confirmStop: boolean;
  setConfirmStop: (value: boolean) => void;
  onStop: () => void;
}) {
  const t = useTheme();
  const line = useLine();
  const [contentHeight, setContentHeight] = useState(LINE);
  // A cleared draft collapses at once; web textareas never report a shrinking scroll height.
  const lines = value ? Math.max(1, Math.round(contentHeight / line)) : 1;
  return (
    <View
      style={{
        maxWidth: 720,
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: GUTTER - 4,
        paddingTop: 8,
        paddingBottom: 8,
        gap: 12,
      }}
    >
      {active && confirmStop && (
        <View style={{ gap: 12, paddingHorizontal: 4 }}>
          <Notice>Stopping also ends any active Flow in this chat.</Notice>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              secondary
              disabled={busy}
              onPress={() => setConfirmStop(false)}
              style={{ flex: 1 }}
            >
              Keep running
            </Button>
            <Button secondary destructive disabled={busy} onPress={onStop} style={{ flex: 1 }}>
              Confirm stop
            </Button>
          </View>
        </View>
      )}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          ...glassStyle(t),
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: (line + PAD * 2) / 2,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, paddingLeft: 18, paddingVertical: PAD }}>
          {active ? (
            <View style={{ height: line, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <ActivityIndicator size="small" color={t.accent} />
              <Text
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={{ fontSize: 16, lineHeight: LINE, color: t.secondary }}
              >
                Frink is working…
              </Text>
            </View>
          ) : (
            <TextInput
              accessibilityLabel="Message"
              placeholder="Message Frink"
              placeholderTextColor={t.muted}
              selectionColor={t.accent}
              value={value}
              onChangeText={onChange}
              editable={!busy}
              multiline
              maxLength={32000}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              scrollEnabled={lines > MAX_LINES}
              onContentSizeChange={(event) => setContentHeight(event.nativeEvent.contentSize.height)}
              style={[
                {
                  height: Math.min(lines, MAX_LINES) * line,
                  padding: 0,
                  fontSize: 16,
                  lineHeight: LINE,
                  color: t.text,
                },
                bareInput,
              ]}
            />
          )}
        </View>
        {active ? (
          <ComposerAction
            label="Stop response…"
            icon="stop"
            enabled={!busy && !confirmStop}
            onPress={() => setConfirmStop(true)}
          />
        ) : (
          <ComposerAction
            label="Send message"
            icon="arrow-up"
            enabled={!!value.trim() && !busy}
            busy={busy}
            onPress={onSend}
          />
        )}
      </View>
    </View>
  );
}
