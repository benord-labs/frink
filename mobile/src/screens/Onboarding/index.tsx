import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { pairComputer } from '../../lib/api';
import { pairingOverlap, replacedComputer } from '../../lib/computers';
import { useConnection } from '../../lib/connection';
import { releaseAlerts } from '../../lib/notifications/registration';
import { Atmosphere } from '../../ui/material';
import { space } from '../../ui/theme';
import { ConfirmStep } from './ConfirmStep';
import { ConnectStep } from './ConnectStep';
import { pairingFailure, readPairing } from './pairing';
import { Scanner } from './Scanner';

type Target = { text: string; host: string; name: string; route: string; key: string };

/**
 * Pairing, shown when no computer is saved, a pairing link opens the app, or Settings adds a
 * computer. Connect hands over a code (scan, paste or link); Confirm names the computer it points
 * at before anything is sent. Rendered outside navigation, so it owns its insets.
 */
// Reason: One screen owns the code's source (scan, paste, link), its confirmation and the pairing request.
// fallow-ignore-next-line complexity
export function Onboarding({ link, onDone }: { link: string | null; onDone: () => void }) {
  const { connect, connection, computers, error: disconnected } = useConnection();
  // Over an existing connection this is a sheet, so it closes rather than steps back.
  const cancel = connection ? onDone : undefined;
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState('');
  const [pasting, setPasting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [deviceName, setDeviceName] = useState('My iPhone');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [keepBoth, setKeepBoth] = useState(false);
  const pasted = readPairing(code);
  const overlap = pairingOverlap(computers, target && { ...target, machine: target.name });

  function choose(text: string) {
    const read = readPairing(text);
    setKeepBoth(false);
    if (read.ok) setTarget(read);
    return read.ok;
  }
  function paste(text: string) {
    setCode(text);
    return choose(text);
  }
  // A link goes straight to Confirm; a broken one opens the field saying what is wrong.
  useEffect(() => {
    if (!link) return;
    setScanning(false);
    if (!paste(link)) setPasting(true);
  }, [link]);
  // A code on the clipboard goes straight to Confirm; anything else opens the field so it can be fixed.
  async function pasteClipboard() {
    const text = await Clipboard.getStringAsync().catch(() => '');
    paste(text);
    setPasting(true);
  }
  async function pair() {
    if (!target || busy) return;
    setBusy(true);
    setFailure(null);
    let next;
    try {
      next = await pairComputer(target.text, deviceName.trim() || 'My iPhone');
    } catch (error) {
      setFailure(pairingFailure(error));
      setBusy(false);
      return;
    }
    const replaced = replacedComputer(overlap, keepBoth);
    try {
      await connect(next, replaced?.deviceId);
      // Once the new pairing is stored: the computer keeps the old one as a separate device, so
      // its alerts stop now; if storing failed, the old pairing stays with its alerts.
      if (replaced) void releaseAlerts(replaced);
      setBusy(false);
      onDone();
    } catch {
      setFailure(
        'This iPhone couldn’t save the connection. Make a new code on your Mac and try again.',
      );
      setBusy(false);
    }
  }
  function restart() {
    setTarget(null);
    setFailure(null);
    setCode('');
    onDone();
  }

  return (
    <View style={{ flex: 1 }}>
      <Atmosphere />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{
            flexGrow: 1,
            width: '100%',
            maxWidth: 520,
            alignSelf: 'center',
            paddingTop: insets.top + space.xl,
            paddingBottom: insets.bottom + space.lg,
            paddingHorizontal: space.xl,
          }}
        >
          {target ? (
            <ConfirmStep
              host={target.host}
              name={target.name}
              deviceName={deviceName}
              overlap={overlap?.kind}
              keepBoth={keepBoth}
              onKeepBoth={setKeepBoth}
              busy={busy}
              failure={failure}
              onDeviceName={setDeviceName}
              onConnect={() => void pair()}
              onBack={restart}
              onCancel={cancel}
            />
          ) : (
            <ConnectStep
              disconnected={disconnected}
              pasting={pasting}
              code={code}
              problem={pasted.ok ? null : pasted.problem}
              onCode={paste}
              onPaste={() => void pasteClipboard()}
              onScanInstead={() => setPasting(false)}
              onScan={() => setScanning(true)}
              onCancel={cancel}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      {scanning && (
        <Scanner
          onScanned={(text) => {
            setScanning(false);
            choose(text);
          }}
          onPaste={() => {
            setScanning(false);
            void pasteClipboard();
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </View>
  );
}
