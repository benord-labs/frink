import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
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
 * The pairing link that opened the app or arrived while it was open, such as the Mac's code
 * scanned with the Camera. `clear` once it has been handled.
 */
export function usePairingLink() {
  const [link, setLink] = useState<string | null>(null);
  useEffect(
    () =>
      onAppLink((url) => {
        const text = asPairingLink(url);
        if (text?.startsWith(MOBILE_PAIRING_LINK)) setLink(text);
      }),
    [],
  );
  return { link, clear: () => setLink(null) };
}
