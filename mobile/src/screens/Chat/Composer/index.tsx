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
import type { MobileChatMode, MobileComposer } from '../../../../../src/shared/types/remote/mobile';
import { Button, GUTTER, Icon, Notice, Row, Section, bareInput } from '../../../ui/primitives';
import { useTheme } from '../../../ui/theme';
import { glassStyle } from '../../../ui/material';
import { ComposerControls, type ComposerPatch } from './controls';
import { Sheet } from './sheet';
import {
  attachmentsSupported,
  type ComposerAttachment,
  type useComposerAttachments,
} from './use-attachments';

export { useComposerAttachments } from './use-attachments';
export { useComposerState } from './use-composer-state';
export type { ComposerPatch } from './controls';

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

type Attachments = ReturnType<typeof useComposerAttachments>;

// Reason: The button, its sheet and the picker hand-off share one control.
// fallow-ignore-next-line complexity
function AttachButton({ attachments, disabled }: { attachments: Attachments; disabled: boolean }) {
  const t = useTheme();
  const line = useLine();
  const [open, setOpen] = useState(false);
  const pick = (picker: () => Promise<void>) => {
    setOpen(false);
    // Let the sheet finish closing before iOS presents the picker over it.
    setTimeout(() => void picker().catch(() => {}), 350);
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Attach"
        accessibilityState={{ disabled: disabled || attachments.full }}
        disabled={disabled || attachments.full}
        onPress={() => setOpen(true)}
        hitSlop={6}
        style={({ pressed }) => ({
          width: ACTION,
          height: ACTION,
          margin: (line + PAD * 2 - ACTION) / 2,
          marginRight: 0,
          borderRadius: ACTION / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.fill,
          opacity: disabled || attachments.full ? 0.4 : pressed ? 0.7 : 1,
        })}
      >
        <Icon name="add" size={20} color={t.secondary} />
      </Pressable>
      {open && (
        <Sheet visible title="Attach" onClose={() => setOpen(false)}>
          {attachmentsSupported ? (
            <Section title="Add to your message">
              <Row
                title="Photos"
                subtitle="Images are sent to the model"
                icon="image-outline"
                separator
                onPress={() => pick(attachments.pickPhotos)}
              />
              <Row
                title="Files"
                subtitle="Saved on your computer for the agent to read"
                icon="document-attach-outline"
                onPress={() => pick(attachments.pickFiles)}
              />
            </Section>
          ) : (
            <Notice>
              This build of Frink can't attach files yet. Install the latest build on this phone to
              attach photos and files.
            </Notice>
          )}
        </Sheet>
      )}
    </>
  );
}

// Reason: Uploading, ready and failed attachments share one chip.
// fallow-ignore-next-line complexity
function TrayItem({
  item,
  onRemove,
  onRetry,
}: {
  item: ComposerAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const t = useTheme();
  const failed = item.status === 'failed';
  return (
    <View
      testID="composer-attachment"
      style={{
        height: 34,
        maxWidth: 220,
        paddingLeft: 10,
        borderRadius: 17,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: failed ? t.dangerSoft : t.fill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: failed ? t.danger : t.border,
      }}
    >
      {item.status === 'uploading' ? (
        <ActivityIndicator size="small" color={t.muted} />
      ) : (
        <Icon
          name={
            failed ? 'alert-circle' : item.kind === 'image' ? 'image-outline' : 'document-outline'
          }
          size={15}
          color={failed ? t.danger : t.secondary}
        />
      )}
      <Pressable
        accessibilityRole={failed ? 'button' : undefined}
        accessibilityLabel={failed ? `Retry ${item.name}. ${item.error ?? ''}` : item.name}
        disabled={!failed}
        onPress={onRetry}
        style={{ flexShrink: 1 }}
      >
        <Text numberOfLines={1} style={{ fontSize: 13, color: failed ? t.danger : t.text }}>
          {failed ? 'Retry · ' : ''}
          {item.name}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${item.name}`}
        onPress={onRemove}
        hitSlop={8}
        style={({ pressed }) => ({ paddingHorizontal: 8, opacity: pressed ? 0.6 : 1 })}
      >
        <Icon name="close" size={15} color={t.muted} />
      </Pressable>
    </View>
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
  composer,
  attachments,
  onUpdate,
  onMode,
  onAccount,
}: {
  active: boolean;
  busy: boolean;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  confirmStop: boolean;
  setConfirmStop: (value: boolean) => void;
  onStop: () => void;
  /** The chat's composer settings; controls appear once they have loaded. */
  composer?: MobileComposer;
  attachments: Attachments;
  onUpdate: (patch: ComposerPatch) => void;
  onMode: (mode: MobileChatMode) => void;
  onAccount: (accountId: string) => void;
}) {
  const t = useTheme();
  const line = useLine();
  const [contentHeight, setContentHeight] = useState(LINE);
  // A cleared draft collapses at once; web textareas never report a shrinking scroll height.
  const lines = value ? Math.max(1, Math.round(contentHeight / line)) : 1;
  const canSend =
    (!!value.trim() || attachments.ids.length > 0) &&
    !busy &&
    !attachments.uploading &&
    !attachments.failed;
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
      {composer && !active && (
        <ComposerControls
          composer={composer}
          disabled={busy}
          onUpdate={onUpdate}
          onMode={onMode}
          onAccount={onAccount}
        />
      )}
      {!active && attachments.items.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 4 }}>
          {attachments.items.map((item) => (
            <TrayItem
              key={item.key}
              item={item}
              onRemove={() => attachments.remove(item.key)}
              onRetry={() => attachments.retry(item.key)}
            />
          ))}
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
        {!active && <AttachButton attachments={attachments} disabled={busy} />}
        <View style={{ flex: 1, minWidth: 0, paddingLeft: active ? 18 : 10, paddingVertical: PAD }}>
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
              onContentSizeChange={(event) =>
                setContentHeight(event.nativeEvent.contentSize.height)
              }
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
            enabled={canSend}
            busy={busy || attachments.uploading}
            onPress={onSend}
          />
        )}
      </View>
    </View>
  );
}
