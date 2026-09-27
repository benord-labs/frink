import { CameraView, useCameraPermissions } from 'expo-camera';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { pairComputer, parsePairing } from '../../lib/api';
import { useConnection } from '../../lib/connection';
import { Button, Field, Icon, Label, Notice, Page, Section } from '../../ui/primitives';
import { useTheme } from '../../ui/theme';

// Reason: Scanning, manual pairing, and connection feedback form one MVP flow.
// fallow-ignore-next-line complexity
export function Pairing() {
  const { connect, error: savedError } = useConnection();
  const [code, setCode] = useState('');
  const [name, setName] = useState('My iPhone');
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useTheme();
  let host: string | null = null;
  try {
    host = new URL(parsePairing(code).url).hostname;
  } catch {
    /* A partial paste is not an error yet. */
  }
  async function pair() {
    setBusy(true);
    setError(null);
    try {
      await connect(await pairComputer(code, name.trim() || 'My iPhone'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pairing failed.');
    } finally {
      setBusy(false);
    }
  }
  async function scan() {
    const result = permission?.granted ? permission : await requestPermission();
    if (result.granted) setScanning(true);
    else setError('Camera access is off. You can paste a pairing code instead.');
  }
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <Page title="Your work, within reach." subtitle="Frink for iPhone">
        <View style={{ paddingVertical: 20, gap: 15 }}>
          <Icon name="git-network-outline" color={t.accent} size={52} />
          <Label size={19}>
            Keep your Flows moving, answer your agents, and pick up a conversation away from your
            desk.
          </Label>
        </View>
        <Section title="Connect your computer">
          <Label muted>
            Open Settings → Mobile in Frink. Enable mobile access, set up the private connection,
            then generate a pairing code.
          </Label>
          <Notice>
            Keep Frink open and your computer awake. Both devices need access to the same private
            network, such as Tailscale.
          </Notice>
          {scanning ? (
            <View style={{ gap: 12 }}>
              <CameraView
                style={{ height: 260, borderRadius: 12 }}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => {
                  setCode(data);
                  setScanning(false);
                }}
              />
              <Button secondary onPress={() => setScanning(false)}>
                Cancel scanning
              </Button>
            </View>
          ) : (
            <Button secondary onPress={() => void scan()}>
              Scan pairing code
            </Button>
          )}
          <Label size={14} bold>
            Or paste your pairing code
          </Label>
          <Field
            accessibilityLabel="Pairing code"
            placeholder="Paste the code from Frink"
            value={code}
            onChangeText={setCode}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            style={{ minHeight: 92 }}
          />
          <Label size={14} bold>
            Device name
          </Label>
          <Field
            accessibilityLabel="Device name"
            value={name}
            onChangeText={setName}
            maxLength={60}
          />
          {host && <Notice>Connect to {host}. Only continue if this is your computer.</Notice>}
          {(error || savedError) && <Notice error>{error || savedError}</Notice>}
          <Button disabled={busy || !host} onPress={() => void pair()}>
            {busy ? 'Connecting…' : 'Connect to Frink'}
          </Button>
        </Section>
      </Page>
    </KeyboardAvoidingView>
  );
}
