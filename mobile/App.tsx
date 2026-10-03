import { ActivityIndicator, Modal, View } from 'react-native';
import { SafeAreaProvider } from './src/ui/safe-area';
import { ConnectionProvider, useConnection } from './src/lib/connection';
import { AlertOpenProvider } from './src/lib/notifications/alert-open';
import { StartPairingProvider, usePairingLink } from './src/lib/pairing-link';
import { Companion } from './src/navigation';
import { Onboarding } from './src/screens/Onboarding';
import { Atmosphere } from './src/ui/material';
import { ThemeProvider, useTheme } from './src/ui/theme';

function SessionContent() {
  const { connection, loading } = useConnection();
  const pairing = usePairingLink();
  const t = useTheme();
  if (loading)
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: t.background }}>
        <Atmosphere />
        <ActivityIndicator color={t.muted} />
      </View>
    );
  const onboarding = <Onboarding link={pairing.link} onDone={pairing.clear} />;
  if (!connection) return onboarding;
  return (
    // Mounted once saved computers have loaded, so the alert that launched the app finds its computer.
    <AlertOpenProvider>
      <StartPairingProvider value={pairing.start}>
        <Companion />
      </StartPairingProvider>
      {/* Pairing opens over the app; nothing changes until Connect, and Cancel keeps its place. */}
      <Modal
        visible={pairing.open}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={pairing.clear}
      >
        {onboarding}
      </Modal>
    </AlertOpenProvider>
  );
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
