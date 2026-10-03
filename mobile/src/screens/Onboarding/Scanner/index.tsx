import { CameraView, useCameraPermissions, type PermissionResponse } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraOff, ClipboardPaste, X } from 'lucide-react-native';
import { Button, IconButton } from '../../../ui/button';
import { backgroundImage, GlassSurface } from '../../../ui/material';
import { Text } from '../../../ui/text';
import { GUTTER, radius, space, themes, useTheme } from '../../../ui/theme';
import { readPairing } from '../pairing';

const FRAME = 248;
const WHITE = '#FFFFFF';

/** The camera is dark in both themes, so its words are always white over a soft scrim. */
const scrim = backgroundImage(
  'linear-gradient(180deg, rgba(0,0,0,0.55), transparent 22%, transparent 62%, rgba(0,0,0,0.7))',
);

/** Full-screen QR scanner. A code that isn't Frink's is named on screen and scanning carries on. */
export function Scanner({
  onScanned,
  onPaste,
  onClose,
}: {
  onScanned: (text: string) => void;
  onPaste: () => void;
  onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const asked = useRef(false);
  const [refused, setRefused] = useState(false);
  // Ask once on open; a refusal (now or earlier) shows the paste fallback instead of a black camera.
  useEffect(() => {
    if (!permission || permission.granted || !permission.canAskAgain || asked.current) return;
    asked.current = true;
    void requestPermission().then(
      (result) => setRefused(!result.granted),
      () => setRefused(true),
    );
  }, [permission, requestPermission]);
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {refused || denied(permission) ? (
        <Denied onPaste={onPaste} onClose={onClose} />
      ) : (
        <Viewfinder
          ready={!!permission?.granted}
          onScanned={onScanned}
          onPaste={onPaste}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function denied(permission: PermissionResponse | null) {
  return !!permission && !permission.granted && !permission.canAskAgain;
}

function Viewfinder({
  ready,
  onScanned,
  onPaste,
  onClose,
}: {
  ready: boolean;
  onScanned: (text: string) => void;
  onPaste: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [problem, setProblem] = useState<string | null>(null);
  const done = useRef(false);
  // The camera reports the same code many times a second; only the first valid one counts.
  function scanned(data: string) {
    if (done.current) return;
    const read = readPairing(data);
    if (!read.ok) return setProblem(read.problem ?? 'That isn’t a Frink pairing code.');
    done.current = true;
    if (Platform.OS === 'ios')
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onScanned(read.text);
  }
  return (
    <View style={{ flex: 1, backgroundColor: '#000000' }}>
      {ready && (
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => scanned(data)}
        />
      )}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, scrim]} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            width: FRAME,
            height: FRAME,
            borderRadius: radius.xl + 6,
            borderWidth: 2,
            borderColor: 'rgba(255,255,255,0.85)',
          }}
        />
      </View>
      <View
        style={{
          paddingHorizontal: GUTTER,
          paddingBottom: insets.bottom + space.xl,
          gap: space.xl,
          alignItems: 'center',
        }}
      >
        <View style={{ gap: space.xs, alignItems: 'center' }}>
          <Text variant="headline" style={{ color: WHITE }}>
            Scan the code on your Mac
          </Text>
          <Text
            variant="secondary"
            accessibilityLiveRegion="polite"
            style={{
              color: problem ? themes.dark.attention : 'rgba(255,255,255,0.72)',
              textAlign: 'center',
            }}
          >
            {problem ?? 'In Frink on your Mac, open Settings → Mobile and scan the code shown there.'}
          </Text>
        </View>
        <GlassSurface style={{ borderRadius: radius.pill }}>
          <Button variant="plain" icon={ClipboardPaste} onPress={onPaste}>
            Paste pairing code
          </Button>
        </GlassSurface>
      </View>
      <View style={{ position: 'absolute', top: insets.top + space.sm, left: GUTTER }}>
        <GlassSurface style={{ borderRadius: 22 }}>
          <IconButton icon={X} label="Close" onPress={onClose} size={44} />
        </GlassSurface>
      </View>
    </View>
  );
}

function Denied({ onPaste, onClose }: { onPaste: () => void; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: t.background, paddingTop: insets.top + space.sm }}>
      <View style={{ paddingHorizontal: GUTTER }}>
        <IconButton icon={X} label="Close" onPress={onClose} size={44} />
      </View>
      <View
        style={{ flex: 1, justifyContent: 'center', paddingHorizontal: space.xxl, gap: space.sm }}
      >
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: radius.lg,
            backgroundColor: t.fill,
            alignItems: 'center',
            justifyContent: 'center',
            alignSelf: 'center',
            marginBottom: space.md,
          }}
        >
          <CameraOff size={26} color={t.muted} />
        </View>
        <Text variant="title" style={{ textAlign: 'center' }} accessibilityRole="header">
          Camera access is off
        </Text>
        <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
          Allow camera access for Frink in the Settings app, or paste the code instead.
        </Text>
      </View>
      <View
        style={{
          paddingHorizontal: GUTTER,
          paddingBottom: insets.bottom + space.xl,
          gap: space.sm,
        }}
      >
        {Platform.OS !== 'web' && (
          <Button onPress={() => void Linking.openSettings()}>Open Settings</Button>
        )}
        <Button
          variant={Platform.OS === 'web' ? 'primary' : 'plain'}
          icon={ClipboardPaste}
          onPress={onPaste}
        >
          Paste pairing code
        </Button>
      </View>
    </View>
  );
}
