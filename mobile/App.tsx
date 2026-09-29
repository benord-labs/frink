import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from './src/ui/safe-area';
import { ConnectionProvider, useConnection } from './src/lib/connection';
import { Companion } from './src/navigation';
import { Onboarding } from './src/screens/Onboarding';
import { Atmosphere } from './src/ui/material';
import { ThemeProvider, useTheme } from './src/ui/theme';

function SessionContent() {
  const { connection, loading } = useConnection();
  const t = useTheme();
  if (loading)
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: t.background }}>
        <Atmosphere />
        <ActivityIndicator color={t.muted} />
      </View>
    );
  if (!connection) return <Onboarding />;
  // A new pairing remounts everything, so no screen shows another computer's data.
  return <Companion key={`${connection.deviceId}:${connection.url}`} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ConnectionProvider>
          <SessionContent />
        </ConnectionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
