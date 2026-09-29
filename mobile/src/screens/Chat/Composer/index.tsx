import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  TextInput,
  View,
  useWindowDimensions,
  type TextStyle,
} from 'react-native';
import { ArrowUp, Square } from 'lucide-react-native';
import type {
  MobileActivity,
  MobileChatMode,
  MobileComposer,
} from '@frink/shared/types/remote/mobile';
import { GlassSurface } from '../../../ui/material';
import { space, useTheme } from '../../../ui/theme';
import {
  actionEnabled,
  composerMode,
  composerPlaceholder,
  type ComposerMode,
} from '../chat-state';
import { Note } from '../note';
import { ACTION, AttachButton, AttachmentTray, type Attachments } from './attach';
import { ComposerControls, type ComposerPatch } from './controls';
import { LINE, messageInputSizing } from './input-sizing';

export { useComposerAttachments } from './use-attachments';
export { useComposerState } from './use-composer-state';
export type { ComposerPatch } from './controls';

// iOS scales lineHeight with Dynamic Type, so every height derived from LINE scales with it too.
const MAX_FONT_SCALE = 1.6;
/** Web inputs draw a focus outline React Native has no prop for. */
export const bareInput: TextStyle =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : {};

function useLine() {
  const { fontScale } = useWindowDimensions();
  return Math.round(LINE * Math.min(Math.max(fontScale, 1), MAX_FONT_SCALE));
}

/** The trailing control: Send (violet arrow) and Stop (square) share one slot, so typing while
 *  Frink works turns Stop into Send in place. */
function ActionButton({
  mode,
  enabled,
  busy,
  stopLabel,
  onSend,
  onStop,
}: {
  mode: ComposerMode;
  enabled: boolean;
  busy: boolean;
  stopLabel: string;
  onSend: () => void;
  onStop: () => void;
}) {
  const t = useTheme();
  const stop = mode === 'stop';
  const bg = !enabled ? t.fill : stop ? t.text : t.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={stop ? stopLabel : 'Send message'}
      accessibilityState={{ disabled: !enabled, busy }}
      disabled={!enabled}
      onPress={stop ? onStop : onSend}
      hitSlop={6}
      style={({ pressed }) => ({
        width: ACTION,
        height: ACTION,
        borderRadius: ACTION / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={t.muted} />
      ) : stop ? (
        <Square size={12} color={t.background} fill={t.background} />
      ) : (
        <ArrowUp size={19} color={enabled ? t.onAccent : t.muted} strokeWidth={2.5} />
      )}
    </Pressable>
  );
}

export function Composer({
  activity,
  executionReady,
  flowRun,
  busy,
  note,
  value,
  onChange,
  onSend,
  onStop,
  composer,
  attachments,
  onUpdate,
  onMode,
  onAccount,
}: {
  activity: MobileActivity;
  executionReady: boolean;
  /** Stopping this chat ends a whole Flow run. */
  flowRun: boolean;
  busy: boolean;
  note: { text: string; error?: boolean } | null;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  composer?: MobileComposer;
  attachments: Attachments;
  onUpdate: (patch: ComposerPatch) => void;
  onMode: (mode: MobileChatMode) => void;
  onAccount: (accountId: string) => void;
}) {
  const t = useTheme();
  const line = useLine();
  const [contentHeight, setContentHeight] = useState(LINE);
  const sizing = messageInputSizing(Platform.OS === 'web', line, contentHeight, !!value);
  const mode = composerMode(activity, !!value.trim(), executionReady);
  const enabled =
    !busy &&
    actionEnabled(mode, {
      text: value,
      files: attachments.ids.length,
      uploading: attachments.uploading,
      failed: attachments.failed,
    });
  // The box holds only what you type and its controls; live state is in the header, and a note
  // is one short caption above the box.
  return (
    <View style={{ gap: 6 }}>
      {note && (
        <View style={{ paddingHorizontal: space.md }}>
          <Note error={note.error}>{note.text}</Note>
        </View>
      )}
      <GlassSurface
        interactive
        style={{ borderRadius: 26, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8, gap: 6 }}
      >
      {activity === 'idle' && executionReady && composer && (
        <ComposerControls
          composer={composer}
          disabled={busy}
          onUpdate={onUpdate}
          onMode={onMode}
          onAccount={onAccount}
        />
      )}
      {mode === 'send' && <AttachmentTray attachments={attachments} />}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
        {mode === 'send' && <AttachButton attachments={attachments} disabled={busy} />}
        <View style={{ flex: 1, minWidth: 0, paddingLeft: mode === 'send' ? 0 : 4 }}>
          <TextInput
            accessibilityLabel="Message"
            placeholder={composerPlaceholder(activity, executionReady)}
            placeholderTextColor={t.muted}
            selectionColor={t.accent}
            value={value}
            onChangeText={onChange}
            editable={!busy && mode !== 'unavailable'}
            multiline
            maxLength={32000}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            scrollEnabled={sizing.scrollEnabled}
            onContentSizeChange={
              sizing.measure
                ? (event) => setContentHeight(event.nativeEvent.contentSize.height)
                : undefined
            }
            style={[
              { padding: 0, marginVertical: (ACTION - line) / 2, fontSize: 16, color: t.text },
              sizing.style,
              bareInput,
            ]}
          />
        </View>
        <ActionButton
          mode={mode}
          enabled={enabled}
          busy={busy || (mode === 'send' && attachments.uploading)}
          stopLabel={flowRun ? 'Stop run' : 'Stop'}
          onSend={onSend}
          onStop={onStop}
        />
      </View>
      </GlassSurface>
    </View>
  );
}
