import Constants from 'expo-constants';
import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { LogOut } from 'lucide-react-native';
import { useConnection } from '../../lib/connection';
import { useOverview } from '../../lib/overview';
import { useTabHeader } from '../../navigation/tab-header';
import { ListRow, RowSeparator } from '../../ui/list';
import { ResourceStatus } from '../../ui/resource-status';
import { Screen } from '../../ui/screen';
import { Text } from '../../ui/text';
import { GUTTER, space, useTheme } from '../../ui/theme';
import { confirmForget, REVOKE_HINT } from './confirm-forget';
import { MacIdentity } from './MacIdentity';
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
    <Screen atmosphere>
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
        <Group title="This Mac">
          <ListRow
            title="Frink version"
            trailing={<Value>{overview.data?.appVersion ?? '—'}</Value>}
          />
          <RowSeparator inset={GUTTER} />
          <ListRow
            title="Address"
            trailing={<Value>{connection ? new URL(connection.url).hostname : '—'}</Value>}
          />
        </Group>
        <Group title="This iPhone">
          <ListRow title="Frink version" trailing={<Value>{APP_VERSION}</Value>} />
          {SOURCE && (
            <>
              <RowSeparator inset={GUTTER} />
              <ListRow title="Built from" subtitle={SOURCE} />
            </>
          )}
        </Group>
        <Group>
          <ForgetRow />
        </Group>
      </ScrollView>
    </Screen>
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
          style={{ paddingHorizontal: GUTTER, paddingBottom: space.xs, textTransform: 'uppercase' }}
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
  const { disconnect } = useConnection();
  async function forget() {
    if (!(await confirmForget())) return;
    // A failure to clear the Keychain is reported by the connection itself, on the pairing screen.
    await disconnect().catch(() => undefined);
  }
  return (
    <View style={{ gap: space.sm }}>
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
      <Text variant="secondary" color="muted" style={{ paddingHorizontal: GUTTER }}>
        {REVOKE_HINT}
      </Text>
    </View>
  );
}
