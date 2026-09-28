import { CameraView, useCameraPermissions } from 'expo-camera';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { pairComputer, parsePairing } from '../../lib/api';
import { useConnection } from '../../lib/connection';
import { Button, Field, Icon, Label, Notice, Section } from '../../ui/primitives';
import { Page } from '../../ui/page';
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
      <Page title="Connect your computer" subtitle="Frink for iPhone">
        <Label size={15} muted>
          Open Settings → Mobile in Frink. Enable mobile access, set up the private connection, then
          generate a pairing code.
        </Label>
        <View style={{ gap: 20 }}>
          {scanning ? (
            <View style={{ gap: 12 }}>
              <View style={{ borderRadius: 8, overflow: 'hidden' }}>
                <CameraView
                  style={{ height: 230 }}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => {
                    setCode(data);
                    setScanning(false);
                  }}
                />
              </View>
              <Button secondary onPress={() => setScanning(false)}>
                Cancel scanning
              </Button>
            </View>
          ) : (
            <Button secondary icon="qr-code-outline" onPress={() => void scan()}>
              Scan pairing code
            </Button>
          )}
          <Section title="Or paste your pairing code" plain>
            <Field
              accessibilityLabel="Pairing code"
              placeholder="Paste the code from Frink"
              value={code}
              onChangeText={setCode}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              style={{ minHeight: 88, fontSize: 14, lineHeight: 20 }}
            />
          </Section>
          <Section title="Device name" plain>
            <Field
              accessibilityLabel="Device name"
              value={name}
              onChangeText={setName}
              maxLength={60}
            />
          </Section>
          {host && <Notice>Connect to {host}. Only continue if this is your computer.</Notice>}
          {(error || savedError) && <Notice error>{error || savedError}</Notice>}
          <Button disabled={busy || !host} onPress={() => void pair()}>
            {busy ? 'Connecting…' : 'Connect to Frink'}
          </Button>
        </View>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name="lock-closed-outline" size={17} color={t.muted} />
          </View>
          <Label size={14} muted style={{ flex: 1 }}>
            Keep Frink open and your computer awake. Both devices need access to the same private
            network, such as Tailscale.
          </Label>
        </View>
      </Page>
    </KeyboardAvoidingView>
  );
}
