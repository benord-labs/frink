import { View } from 'react-native';
import { ArrowLeftRight, ChevronLeft, Laptop, RefreshCw, ShieldCheck, X } from 'lucide-react-native';
import { Button, IconButton } from '../../../ui/button';
import { Text } from '../../../ui/text';
import { radius, space, useTheme } from '../../../ui/theme';
import { Field } from '../Field';
import { Notice } from '../Notice';

/**
 * Names the Mac a code points at before anything is sent to it. `onCancel` closes the sheet a
 * pairing link opened over the app.
 */
export function ConfirmStep({
  host,
  name,
  overlap,
  keepBoth,
  onKeepBoth,
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
  /** How the code relates to a computer already paired, if at all. */
  overlap?: 'repair' | 'namesake';
  keepBoth: boolean;
  onKeepBoth: (keepBoth: boolean) => void;
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
          End-to-end encrypted via {host}
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
        <OverlapNotice name={name} overlap={overlap} keepBoth={keepBoth} onKeepBoth={onKeepBoth} />
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

const REPAIR = (name: string) => ({
  icon: RefreshCw,
  title: `Re-pairs ${name}`,
  detail: 'This iPhone updates its saved pairing for this computer.',
  toggle: null,
});
const REPLACE = (name: string) => ({
  icon: ArrowLeftRight,
  title: `Replaces your other ${name}`,
  detail: 'A computer gets a new code when its mobile access is reset, so the old pairing no longer works.',
  toggle: 'Keep both',
});
const KEEP_BOTH = (name: string) => ({
  icon: ArrowLeftRight,
  title: `Keeps both ${name} pairings`,
  detail: 'Both stay in your list of computers.',
  toggle: 'Replace it instead',
});

/** Says how this code relates to a computer already paired; a same-named one can be kept too. */
function OverlapNotice({
  name,
  overlap,
  keepBoth,
  onKeepBoth,
}: {
  name: string;
  overlap?: 'repair' | 'namesake';
  keepBoth: boolean;
  onKeepBoth: (keepBoth: boolean) => void;
}) {
  if (!overlap) return null;
  const copy = overlap === 'repair' ? REPAIR(name) : (keepBoth ? KEEP_BOTH : REPLACE)(name);
  return (
    <View style={{ gap: space.xs }}>
      <Notice icon={copy.icon} tone="attention" title={copy.title} detail={copy.detail} />
      {copy.toggle && (
        <Button variant="plain" small onPress={() => onKeepBoth(!keepBoth)}>
          {copy.toggle}
        </Button>
      )}
    </View>
  );
}
