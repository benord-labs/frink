import Constants from 'expo-constants';
import { Fragment, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Check, LogOut } from 'lucide-react-native';
import { useConnection } from '../../lib/connection';
import { useNotifications } from '../../lib/notifications';
import { useOverview } from '../../lib/overview';
import { useTabHeader } from '../../navigation/tab-header';
import { ListRow, RowSeparator } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useAppearance, useTheme } from '../../ui/theme';
import { Card } from './card';
import { confirmForget } from './confirm-forget';
import { Computers } from './Computers';
import { MacIdentity } from './MacIdentity';
import { Notifications } from './Notifications';
import { macStatus, sourceLine } from './settings-view';

// Web previews draw the tab bar over the page; iOS insets content under its native bar itself.
const TAB_BAR_CLEARANCE = Platform.OS === 'web' ? 96 : space.xl;
const APP_VERSION = Constants.expoConfig?.version ?? 'Unknown';
// Where the running JavaScript came from helps while developing; it is jargon to everyone else.
const SOURCE = __DEV__ ? sourceLine(Constants.expoConfig?.extra?.source) : null;

export function SettingsScreen() {
  const { header } = useTabHeader({ title: 'Settings' });
  const overview = useOverview();
  const { connection } = useConnection();
  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: TAB_BAR_CLEARANCE }}
      >
        {header}
        <ResourceStatus {...overview} />
        <MacIdentity
          name={overview.data?.machineName ?? connection?.machineName ?? 'Your Mac'}
          status={macStatus(overview)}
        />
        <Group title="Appearance">
          <AppearanceSettings />
        </Group>
        <Group title="Computers">
          <Computers />
        </Group>
        <Group title="Notifications">
          <Notifications />
        </Group>
        <Group title="About">
          <Card testID="settings-about">
            <ListRow
              title="Frink on your Mac"
              trailing={<Value>{overview.data?.appVersion ?? '—'}</Value>}
            />
            <RowSeparator inset={GUTTER} />
            <ListRow title="Frink on this iPhone" trailing={<Value>{APP_VERSION}</Value>} />
            {SOURCE && (
              <>
                <RowSeparator inset={GUTTER} />
                <ListRow title="Built from" subtitle={SOURCE} />
              </>
            )}
          </Card>
        </Group>
        <Group>
          <Card>
            <ForgetRow />
          </Card>
        </Group>
      </ScrollView>
    </Screen>
  );
}

const APPEARANCES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const;

function AppearanceSettings() {
  const t = useTheme();
  const { mode, setMode } = useAppearance();
  return (
    <Card testID="settings-appearance">
      <View accessibilityRole="radiogroup" accessibilityLabel="Appearance">
        {APPEARANCES.map((item, index) => (
          <Fragment key={item.id}>
            {index > 0 && <RowSeparator inset={GUTTER} />}
            <Pressable
              accessibilityRole="radio"
              accessibilityLabel={item.label}
              accessibilityState={{ checked: mode === item.id }}
              aria-checked={mode === item.id}
              onPress={() => setMode(item.id)}
              style={({ pressed }) => ({
                minHeight: 52,
                paddingHorizontal: GUTTER,
                paddingVertical: space.md,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: pressed ? t.pressed : 'transparent',
              })}
            >
              <Text variant="row">{item.label}</Text>
              {mode === item.id && <Check size={20} color={t.accent} />}
            </Pressable>
          </Fragment>
        ))}
      </View>
    </Card>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={{ paddingTop: space.xl }}>
      {title && (
        <Text
          variant="label"
          color="muted"
          accessibilityRole="header"
          style={{
            paddingHorizontal: GUTTER * 2,
            paddingBottom: space.xs,
            textTransform: 'uppercase',
          }}
        >
          {title}
        </Text>
      )}
      {children}
    </View>
  );
}

function Value({ children }: { children: string }) {
  return (
    <Text variant="secondary" color="muted" numberOfLines={1} ellipsizeMode="middle" selectable>
      {children}
    </Text>
  );
}

function ForgetRow() {
  const t = useTheme();
  const { connection, forget: forgetComputer } = useConnection();
  const { unregister, resume } = useNotifications();
  async function forget() {
    if (!connection || !(await confirmForget())) return;
    // Alerts are removed before the encrypted channel closes, through the one update queue.
    await unregister();
    // A Mac that couldn't be forgotten stays, with its alerts working again; the connection
    // reports the failure itself.
    await forgetComputer(connection.deviceId).catch(resume);
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => void forget()}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        minHeight: 52,
        paddingHorizontal: GUTTER,
        backgroundColor: pressed ? t.pressed : 'transparent',
      })}
    >
      <LogOut size={20} color={t.danger} />
      <Text variant="row" color="danger">
        Forget this Mac
      </Text>
    </Pressable>
  );
}
