import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { LogOut } from 'lucide-react-native';
import { useConnection } from '../../lib/connection';
import { useNotifications } from '../../lib/notifications';
import { useOverview } from '../../lib/overview';
import { useScreenHeader } from '../../navigation/screen-header';
import { ListRow, RowSeparator } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useAppearance, useTransparency, useTheme } from '../../ui/theme';
import { TRANSPARENCY_LEVELS } from '../../lib/preferences';
import { MenuChip } from '../Chat/Composer/menu';
import { Card } from './card';
import { confirmForget } from './confirm-forget';
import { Computers } from './Computers';
import { MacIdentity } from './MacIdentity';
import { Notifications } from './Notifications';
import { macStatus, sourceLine } from './settings-view';

const APP_VERSION = Constants.expoConfig?.version ?? 'Unknown';
// Where the running JavaScript came from helps while developing; it is jargon to everyone else.
const SOURCE = __DEV__ ? sourceLine(Constants.expoConfig?.extra?.source) : null;

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { header } = useScreenHeader({ title: 'Settings' });
  const overview = useOverview();
  const { connection } = useConnection();
  return (
    <Screen atmosphere>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
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
  const { mode, setMode } = useAppearance();
  const { level, setLevel } = useTransparency();
  return (
    <Card testID="settings-appearance">
      <PreferenceRow label="Appearance">
        <MenuChip
          label={APPEARANCES.find((item) => item.id === mode)!.label}
          accessibilityLabel={`Appearance: ${APPEARANCES.find((item) => item.id === mode)!.label}`}
          groups={[
            {
              value: mode,
              options: [...APPEARANCES],
              onPick: (id) => {
                const option = APPEARANCES.find((item) => item.id === id);
                if (option) setMode(option.id);
              },
            },
          ]}
        />
      </PreferenceRow>
      <RowSeparator inset={GUTTER} />
      <PreferenceRow label="Transparency">
        <MenuChip
          label={`${level}%`}
          accessibilityLabel={`Transparency: ${level}%`}
          groups={[
            {
              value: String(level),
              options: TRANSPARENCY_LEVELS.map((value) => ({
                id: String(value),
                label: value === 0 ? '0% (Solid)' : `${value}%`,
              })),
              onPick: (id) => {
                const option = TRANSPARENCY_LEVELS.find((value) => String(value) === id);
                if (option !== undefined) setLevel(option);
              },
            },
          ]}
        />
      </PreferenceRow>
    </Card>
  );
}

function PreferenceRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View
      style={{
        minHeight: 52,
        paddingHorizontal: GUTTER,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.md,
      }}
    >
      <Text variant="row">{label}</Text>
      {children}
    </View>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={{ paddingTop: space.xl }}>
      {title && (
        <Text
          variant="secondary"
          accessibilityRole="header"
          style={{
            paddingHorizontal: GUTTER,
            paddingBottom: space.xs,
            fontWeight: '600',
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
