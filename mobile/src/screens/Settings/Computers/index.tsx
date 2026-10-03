import { Check, Plus } from 'lucide-react-native';
import { useConnection } from '../../../lib/connection';
import { useStartPairing } from '../../../lib/pairing-link';
import { ListRow, RowSeparator } from '../../../ui/list';
import { GUTTER, useTheme } from '../../../ui/theme';
import { Card } from '../card';

const pairedOn = (time: number) =>
  `Paired ${new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

/** Every paired computer: tap one to show it, or add another without forgetting the rest. */
export function Computers() {
  const t = useTheme();
  const { computers, connection, select } = useConnection();
  const startPairing = useStartPairing();
  return (
    <Card testID="settings-computers">
      {computers.map((computer) =>
        computer.deviceId === connection?.deviceId ? (
          <ListRow
            key={computer.deviceId}
            title={computer.machineName}
            subtitle={pairedOn(computer.pairedAt)}
            trailing={<Check size={20} color={t.accent} />}
            accessibilityLabel={`${computer.machineName}, shown`}
          />
        ) : (
          <ListRow
            key={computer.deviceId}
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
    </Card>
  );
}
