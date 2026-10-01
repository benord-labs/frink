import { View } from 'react-native';
import { ArrowLeftRight, ChevronLeft, Laptop, ShieldCheck, X } from 'lucide-react-native';
import { Button, IconButton } from '../../../ui/button';
import { Text } from '../../../ui/text';
import { radius, space, useTheme } from '../../../ui/theme';
import { Field } from '../Field';
import { Notice } from '../Notice';

/**
 * Names the Mac a code points at before anything is sent to it. `replacing` is the other Mac this
 * iPhone already uses; `onCancel` closes the sheet a pairing link opened over the app.
 */
export function ConfirmStep({
  host,
  name,
  replacing,
  deviceName,
  busy,
  failure,
  onDeviceName,
  onConnect,
  onBack,
  onCancel,
}: {
  host: string;
  name: string;
  replacing?: string;
  deviceName: string;
  busy: boolean;
  failure: string | null;
  onDeviceName: (name: string) => void;
  onConnect: () => void;
  onBack: () => void;
  onCancel?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: space.xxl }}>
      <View style={{ marginLeft: -space.xs }}>
        {onCancel ? (
          <IconButton icon={X} label="Cancel" onPress={onCancel} />
        ) : (
          <IconButton icon={ChevronLeft} label="Use a different code" onPress={onBack} />
        )}
      </View>
      <View style={{ gap: space.lg }}>
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: radius.lg,
            backgroundColor: t.fill,
            borderWidth: 1,
            borderColor: t.borderSubtle,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: space.xs,
          }}
        >
          <Laptop size={26} color={t.text} strokeWidth={1.8} />
        </View>
        <Text variant="title" accessibilityRole="header">
          Connect to {name}?
        </Text>
        <Text variant="body" color="secondary" selectable style={{ marginTop: -space.sm }}>
          {host}
        </Text>
      </View>
      <Field
        label="This iPhone’s name"
        hint="Shown in Frink on your Mac, so you can tell your devices apart."
        value={deviceName}
        onChangeText={onDeviceName}
        maxLength={60}
        returnKeyType="go"
        onSubmitEditing={onConnect}
      />
      <View style={{ flex: 1, minHeight: space.lg }} />
      <View style={{ gap: space.lg }}>
        {replacing && (
          <Notice
            icon={ArrowLeftRight}
            tone="attention"
            title={`This replaces ${replacing}`}
            detail="This iPhone stops using it once you connect."
          />
        )}
        {failure && <Notice title="Couldn’t connect" detail={failure} />}
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <ShieldCheck size={18} color={t.muted} />
          <Text variant="secondary" color="muted" style={{ flex: 1 }}>
            Only connect if this is your Mac.
          </Text>
        </View>
        <Button busy={busy} onPress={onConnect} accessibilityLabel="Connect">
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </View>
    </View>
  );
}
