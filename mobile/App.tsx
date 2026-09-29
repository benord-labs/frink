import { ActivityIndicator, Modal, View } from 'react-native';
import { SafeAreaProvider } from './src/ui/safe-area';
import { ConnectionProvider, useConnection } from './src/lib/connection';
import { usePairingLink } from './src/lib/pairing-link';
import { Companion } from './src/navigation';
import { Onboarding } from './src/screens/Onboarding';
import { Atmosphere } from './src/ui/material';
import { ThemeProvider, useTheme } from './src/ui/theme';

function SessionContent() {
  const { connection, loading } = useConnection();
  const pairingLink = usePairingLink();
  const t = useTheme();
  if (loading)
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: t.background }}>
        <Atmosphere />
        <ActivityIndicator color={t.muted} />
      </View>
    );
  const onboarding = <Onboarding link={pairingLink.link} onDone={pairingLink.clear} />;
  if (!connection) return onboarding;
  return (
    <>
      {/* A new pairing remounts everything, so no screen shows another computer's data. */}
      <Companion key={`${connection.deviceId}:${connection.url}`} />
      {/* A pairing link opens over the app; nothing changes until Connect, and Cancel keeps its place. */}
      <Modal
        visible={!!pairingLink.link}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={pairingLink.clear}
      >
        {onboarding}
      </Modal>
    </>
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
