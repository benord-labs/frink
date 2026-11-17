import { useState, type ReactNode } from 'react';
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
  acceptsMessage,
  actionEnabled,
  composerMode,
  composerPlaceholder,
  type ComposerMode,
} from '../chat-state';
import { Note } from '../note';
import { ACTION, AttachButton, AttachmentTray, type Attachments } from './attach';
import { ModeMenu, ModelMenus, type ComposerPatch } from './controls';
import { LINE, messageInputSizing } from './input-sizing';

export { useComposerAttachments } from './use-attachments';
export { useComposerState } from './use-composer-state';
export type { ComposerPatch } from './controls';

// iOS scales lineHeight with Dynamic Type, so every height derived from LINE scales with it too.
const MAX_FONT_SCALE = 2;
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
  inline,
  below,
  attach = true,
  autoFocus = false,
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
  /** Stand in for the model menus and the row under the box, for a chat that doesn't exist yet. */
  inline?: ReactNode;
  below?: ReactNode;
  /** Uploads belong to a chat, so a blank one takes files once it exists. */
  attach?: boolean;
  autoFocus?: boolean;
  attachments: Attachments;
  onUpdate: (patch: ComposerPatch) => void;
  onMode: (mode: MobileChatMode) => void;
  onAccount?: (accountId: string) => void;
}) {
  const t = useTheme();
  const line = useLine();
  const [contentHeight, setContentHeight] = useState(LINE);
  const sizing = messageInputSizing(Platform.OS === 'web', line, contentHeight, !!value);
  const mode = composerMode(
    activity,
    { text: value, files: attachments.items.length },
    executionReady,
    flowRun,
  );
  // Any message that can start a turn takes files, so Attach stays put as Stop turns into Send.
  const attachable = attach && acceptsMessage(activity, executionReady, flowRun);
  const enabled =
    !busy &&
    actionEnabled(mode, {
      text: value,
      files: attachments.ids.length,
      uploading: attachments.uploading,
      failed: attachments.failed,
    });
  const choosing = activity === 'idle' && executionReady;
  const settings =
    inline ??
    (composer && (
      <ModelMenus composer={composer} disabled={busy} onUpdate={onUpdate} onAccount={onAccount} />
    ));
  const context =
    below ??
    (composer && (
      <ModeMenu
        mode={composer.mode}
        debugAvailable={composer.debugAvailable}
        disabled={busy}
        onMode={onMode}
      />
    ));
  // Context stays above the floating composer; the model and Send share its lower row.
  return (
    <View style={{ gap: 6 }}>
      {note && (
        <View style={{ paddingHorizontal: space.md }}>
          <Note error={note.error}>{note.text}</Note>
        </View>
      )}
      {choosing && context && (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: space.lg,
            paddingHorizontal: space.lg,
          }}
        >
          {context}
        </View>
      )}
      <GlassSurface style={{ borderRadius: 25, padding: 12, gap: 10 }}>
        {attachable && <AttachmentTray attachments={attachments} />}
        <View style={{ paddingHorizontal: 4 }}>
          <TextInput
            accessibilityLabel="Message"
            placeholder={composerPlaceholder(activity, executionReady, flowRun)}
            placeholderTextColor={t.muted}
            selectionColor={t.accent}
            value={value}
            onChangeText={onChange}
            editable={!busy && mode !== 'unavailable'}
            autoFocus={autoFocus}
            multiline
            maxLength={32000}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            scrollEnabled={sizing.scrollEnabled}
            onContentSizeChange={
              sizing.measure
                ? (event) => setContentHeight(event.nativeEvent.contentSize.height)
                : undefined
            }
            style={[{ padding: 0, fontSize: 17, color: t.text }, sizing.style, bareInput]}
          />
        </View>
        <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          {attachable && <AttachButton attachments={attachments} disabled={busy} />}
          <View
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
            }}
          >
            {choosing && settings}
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
