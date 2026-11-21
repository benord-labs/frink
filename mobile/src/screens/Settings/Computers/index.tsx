import type { ReactNode } from 'react';
import { Check, Plus } from 'lucide-react-native';
import { useConnection } from '../../../lib/connection';
import { useOverview } from '../../../lib/overview';
import { useStartPairing } from '../../../lib/pairing-link';
import { StatusDot } from '../../../ui/glyphs';
import { ListRow, RowSeparator } from '../../../ui/list';
import { Text } from '../../../ui/text';
import { GUTTER, useTheme } from '../../../ui/theme';
import { Card } from '../card';
import { computerStatus, statusLine } from '../settings-view';

const pairedOn = (time: number) =>
  `Paired ${new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

/** Every paired computer, the shown one ticked with how it is doing, then Add a computer and a last row. */
export function Computers({ children }: { children: ReactNode }) {
  const t = useTheme();
  const { computers, connection, select } = useConnection();
  const status = computerStatus(useOverview());
  const startPairing = useStartPairing();
  return (
    <Card testID="settings-computers">
      {computers.map((computer) =>
        computer.deviceId === connection?.deviceId ? (
          <ListRow
            key={computer.deviceId}
            leading={<StatusDot tone={status.tone} />}
            title={computer.machineName}
            subtitle={
              <Text variant="secondary" color="muted" accessibilityLiveRegion="polite">
                {statusLine(status)}
              </Text>
            }
            trailing={<Check size={20} color={t.accent} />}
            accessibilityLabel={`${computer.machineName}, shown, ${status.label}`}
          />
        ) : (
          <ListRow
            key={computer.deviceId}
            leading={<StatusDot tone="quiet" />}
            title={computer.machineName}
            subtitle={pairedOn(computer.pairedAt)}
            onPress={() => select(computer.deviceId)}
          />
        ),
      )}
      <RowSeparator inset={GUTTER} />
      <ListRow
        leading={<Plus size={20} color={t.accent} />}
        title="Add a computer"
        onPress={startPairing}
      />
      <RowSeparator inset={GUTTER} />
      {children}
    </Card>
  );
}
