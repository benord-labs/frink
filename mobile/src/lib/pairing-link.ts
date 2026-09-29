import { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { MOBILE_PAIRING_LINK } from '@frink/shared/types/remote/mobile';

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
  useEffect(() => {
    const take = (url: string | null) => {
      const text = asPairingLink(url);
      if (text?.startsWith(MOBILE_PAIRING_LINK)) setLink(text);
    };
    void Linking.getInitialURL().then(take);
    const subscription = Linking.addEventListener('url', ({ url }) => take(url));
    return () => subscription.remove();
  }, []);
  return { link, clear: () => setLink(null) };
}
