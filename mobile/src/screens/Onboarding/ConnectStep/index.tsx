import { Image, View } from 'react-native';
import { ClipboardPaste, ScanQrCode, Unplug, X } from 'lucide-react-native';
import { Button, IconButton } from '../../../ui/button';
import { Text } from '../../../ui/text';
import { space, useTheme } from '../../../ui/theme';
import { Checklist } from '../Checklist';
import { Field } from '../Field';
import { Notice } from '../Notice';

const mark = require('../../../../assets/frink-mark.png');

/**
 * The first screen: the brand moment, how pairing works, and the two ways to hand over a code.
 * Pasting drops the explainer so the field sits under the title, clear of the keyboard.
 */
export function ConnectStep({
  disconnected,
  pasting,
  code,
  problem,
  onCode,
  onPaste,
  onScanInstead,
  onScan,
  onCancel,
}: {
  disconnected: string | null;
  pasting: boolean;
  code: string;
  problem: string | null;
  onCode: (text: string) => void;
  onPaste: () => void;
  onScanInstead: () => void;
  onScan: () => void;
  /** Back to the app, when a pairing link opened this over an existing connection. */
  onCancel?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: space.xxl }}>
      {onCancel && (
        <View style={{ marginLeft: -space.xs }}>
          <IconButton icon={X} label="Cancel" onPress={onCancel} />
        </View>
      )}
      <View style={{ gap: space.lg }}>
        <Image
          source={mark}
          accessibilityLabel="Frink"
          style={{ width: 30, height: 53, tintColor: t.accent, marginBottom: space.md }}
        />
        <Text variant="largeTitle" accessibilityRole="header">
          Your Mac, in your pocket
        </Text>
        {!pasting && (
          <Text variant="body" color="secondary">
            Answer Frink’s questions, check on runs and start chats while you’re away from your desk.
          </Text>
        )}
      </View>
      {disconnected && !pasting && (
        <Notice
          icon={Unplug}
          tone="attention"
          title="This iPhone was disconnected"
          detail={disconnected}
        />
      )}
      {!pasting && <Checklist />}
      {!pasting && <View style={{ flex: 1, minHeight: space.lg }} />}
      {pasting ? (
        <View style={{ gap: space.md }}>
          <Field
            label="Pairing code"
            placeholder="Paste the code from Frink on your Mac"
            value={code}
            onChangeText={onCode}
            autoFocus
            multiline
            mono={!!code}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={{ minHeight: 96 }}
          />
          {problem && (
            <Text variant="secondary" color="danger" accessibilityLiveRegion="polite">
              {problem}
            </Text>
          )}
          <Button variant="plain" icon={ScanQrCode} onPress={onScanInstead}>
            Scan the code instead
          </Button>
        </View>
      ) : (
        <View style={{ gap: space.sm }}>
          <Button icon={ScanQrCode} onPress={onScan}>
            Scan pairing code
          </Button>
          <Button variant="plain" icon={ClipboardPaste} onPress={onPaste}>
            Paste pairing code
          </Button>
        </View>
      )}
    </View>
  );
}
