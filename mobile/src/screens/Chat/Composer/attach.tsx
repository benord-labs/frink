import { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { CircleAlert, FileText, Image as ImageIcon, Paperclip, Plus, X } from 'lucide-react-native';
import { Text } from '../../../ui/text';
import { radius, space, useTheme } from '../../../ui/theme';
import { Note } from '../note';
import { OptionRow, Sheet, SheetSection } from './sheet';
import {
  attachmentsSupported,
  type ComposerAttachment,
  type useComposerAttachments,
} from './use-attachments';

export type Attachments = ReturnType<typeof useComposerAttachments>;
export const ACTION = 34;

/** The composer's leading (+): Photos or Files, each uploaded as soon as it is picked. */
export function AttachButton({
  attachments,
  disabled,
}: {
  attachments: Attachments;
  disabled: boolean;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const inactive = disabled || attachments.full;
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
        accessibilityState={{ disabled: inactive }}
        disabled={inactive}
        onPress={() => setOpen(true)}
        hitSlop={5}
        style={({ pressed }) => ({
          width: ACTION,
          height: ACTION,
          borderRadius: ACTION / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.fill,
          opacity: inactive ? 0.4 : pressed ? 0.7 : 1,
        })}
      >
        <Plus size={19} color={t.text} strokeWidth={2.1} />
      </Pressable>
      {open && (
        <Sheet title="Attach" onClose={() => setOpen(false)}>
          {attachmentsSupported ? (
            <SheetSection title="Add to your message">
              <OptionRow
                icon={ImageIcon}
                title="Photos"
                subtitle="Frink can see the image"
                separator
                onPress={() => pick(attachments.pickPhotos)}
              />
              <OptionRow
                icon={Paperclip}
                title="Files"
                subtitle="Saved on your Mac for Frink to read"
                onPress={() => pick(attachments.pickFiles)}
              />
            </SheetSection>
          ) : (
            <View style={{ paddingHorizontal: space.lg }}>
              <Note>Install the latest Frink app on this phone to attach photos and files.</Note>
            </View>
          )}
        </Sheet>
      )}
    </>
  );
}

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
  const Icon = failed ? CircleAlert : item.kind === 'image' ? ImageIcon : FileText;
  return (
    <View
      testID="composer-attachment"
      style={{
        height: 32,
        maxWidth: 230,
        paddingLeft: 10,
        borderRadius: radius.pill,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: failed ? t.dangerSoft : t.fill,
      }}
    >
      {item.status === 'uploading' ? (
        <ActivityIndicator size="small" color={t.muted} />
      ) : (
        <Icon size={14} color={failed ? t.danger : t.secondary} />
      )}
      <Pressable
        accessibilityRole={failed ? 'button' : undefined}
        accessibilityLabel={failed ? `Retry ${item.name}. ${item.error ?? ''}` : item.name}
        disabled={!failed}
        onPress={onRetry}
        style={{ flexShrink: 1 }}
      >
        <Text variant="secondary" numberOfLines={1} color={failed ? 'danger' : 'text'}>
          {failed ? `Retry · ${item.name}` : item.name}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${item.name}`}
        onPress={onRemove}
        hitSlop={8}
        style={({ pressed }) => ({ paddingRight: 10, paddingLeft: 2, opacity: pressed ? 0.6 : 1 })}
      >
        <X size={14} color={t.muted} strokeWidth={2.2} />
      </Pressable>
    </View>
  );
}

export function AttachmentTray({ attachments }: { attachments: Attachments }) {
  if (!attachments.items.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {attachments.items.map((item) => (
        <TrayItem
          key={item.key}
          item={item}
          onRemove={() => attachments.remove(item.key)}
          onRetry={() => attachments.retry(item.key)}
        />
      ))}
    </View>
  );
}
