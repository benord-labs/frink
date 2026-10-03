import Constants from 'expo-constants';
import { createContext, useContext, useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { MOBILE_PAIRING_LINK } from '@frink/shared/types/remote/mobile';

/** Where a tap on the Lock Screen card leads: the Queue tab. */
export const QUEUE_LINK = `${Constants.expoConfig?.scheme}://queue`;

/** Calls `take` with the link that opened the app, then with each link that arrives while open. */
function onAppLink(take: (url: string | null) => void) {
  void Linking.getInitialURL().then(take);
  const subscription = Linking.addEventListener('url', ({ url }) => take(url));
  return () => subscription.remove();
}

/** Calls `open` when a tap on the Lock Screen card opened or launched the app. */
export function onQueueLink(open: () => void) {
  return onAppLink((url) => url === QUEUE_LINK && open());
}

/** Browser previews have no custom scheme, so the page's own /pair?… address stands in for it. */
function asPairingLink(url: string | null) {
  if (!url || Platform.OS !== 'web') return url;
  return url.replace(/^https?:\/\/[^/]+\/pair\?/, `${MOBILE_PAIRING_LINK}?`);
}

/**
 * The pairing sheet: open for a pairing link that opened the app or arrived while it was open
 * (such as a computer's code scanned with the Camera), or after `start` from Settings to add a
 * computer. `clear` once it has been handled.
 */
export function usePairingLink() {
  const [link, setLink] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  useEffect(
    () =>
      onAppLink((url) => {
        const text = asPairingLink(url);
        if (text?.startsWith(MOBILE_PAIRING_LINK)) setLink(text);
      }),
    [],
  );
  return {
    link,
    open: started || link !== null,
    start: () => setStarted(true),
    clear: () => {
      setLink(null);
      setStarted(false);
    },
  };
}

const StartPairing = createContext<() => void>(() => {});
/** Lets screens inside the app open the pairing sheet the app root owns. */
export const StartPairingProvider = StartPairing.Provider;
export function useStartPairing() {
  return useContext(StartPairing);
}
