import type { usePluginChatTools } from '../../../hooks/usePluginChatTools';
import { TransientConnectDialog } from '@/components/TransientConnectDialog';

/** The browser-consent dialog of a chat-only plugin's Connect: the same connecting/failed surface a provider's connect chain shows, with its one grant on the checklist and the sign-in page to copy. */
export function PluginChatConsentDialog({
  id,
  name,
  chat,
  onRetry,
}: {
  id: string;
  name: string;
  chat: ReturnType<typeof usePluginChatTools>;
  onRetry: () => void;
}) {
  const { consent, dismiss } = chat;
  return (
    <TransientConnectDialog
      connectingProvider={consent.open ? id : null}
      connectError={consent.open ? consent.error : null}
      connectLink={consent.url ? { url: consent.url, browserLaunchFailed: false } : null}
      checklist={[{ done: chat.state === 'connected' }]}
      provider={{ id, display_name: name }}
      onClose={dismiss}
      onRetry={onRetry}
    />
  );
}
