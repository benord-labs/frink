import { useIsFocused } from '@react-navigation/native';
import { requireOptionalNativeModule } from 'expo';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useConnection } from '../connection';
import { useDrafts } from '../drafts';
import { DICTATION_MODULES, voiceAvailable } from './available';
import { Dictation, IDLE } from './dictation';
import { nativeRecognizer } from './recognizer';

/** False on web and on builds made before voice was added, which then show no microphone. */
export const voiceSupported = voiceAvailable(
  DICTATION_MODULES,
  Platform.OS,
  requireOptionalNativeModule,
);

/** Dictation into the named draft. It ends when the screen closes or is covered, the chat or
 *  computer changes, `enabled` turns false, or the app goes to the background. */
export function useDictation(draft: string, enabled: boolean) {
  const drafts = useDrafts();
  const deviceId = useConnection().connection?.deviceId;
  // Stacks and tabs keep a covered screen mounted, so leaving it must end its dictation too.
  const focused = useIsFocused();
  const [state, setState] = useState(IDLE);
  const dictation = useRef<Dictation | null>(null);
  useEffect(() => {
    if (!voiceSupported || !enabled || !focused) return;
    const current = new Dictation({
      recognizer: nativeRecognizer,
      read: () => drafts.get(draft, '').value,
      write: (text) => drafts.update(draft, text),
      onChange: setState,
    });
    dictation.current = current;
    const appState = AppState.addEventListener('change', (next) => current.appStateChanged(next));
    return () => {
      appState.remove();
      current.abort();
      dictation.current = null;
      setState(IDLE);
    };
    // The draft store is rebuilt each render; the draft name and computer are what identify it.
  }, [draft, deviceId, enabled, focused]);
  return {
    ...state,
    toggle() {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      dictation.current?.toggle();
    },
    abort: () => dictation.current?.abort(),
    edited: (text: string) => dictation.current?.edited(text),
  };
}
