import { useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { useConnection } from '../connection';
import { relayLink } from '../relay/client';
import { cacheWriter, type CacheWrite } from '../resource/cache';
import { ChatStream } from './stream';

/** The chat's own resource: what it shows, and `put` to draw a chat that arrived another way. */
type ChatResource = {
  data?: MobileChatDetail;
  put: (detail: MobileChatDetail, write: CacheWrite) => void;
};

/** Keeps one conversation live while its screen is in front and the app is open; `onLive` says
 * whether it is, and each change is drawn through the chat's own resource. Returns `refresh`. */
export function useChatStream(
  chatId: string,
  subChatId: string | undefined,
  resource: ChatResource,
  onLive: (live: boolean) => void,
) {
  const { connection, request } = useConnection();
  const focused = useIsFocused();
  const [away, setAway] = useState(AppState.currentState === 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setAway(state === 'background'),
    );
    return () => subscription.remove();
  }, []);
  // Read when events land, so the stream draws through this render's resource and computer.
  const latest = useRef({ resource, deviceId: connection?.deviceId });
  const live = useRef<ChatStream>(undefined);
  latest.current = { resource, deviceId: connection?.deviceId };
  useEffect(() => {
    if (!connection || !focused || away) return;
    const host = connection;
    const write = cacheWriter(host.deviceId);
    const stream = new ChatStream({
      link: () => relayLink(host),
      watch: () => request({ type: 'watchChat', chatId, subChatId }, undefined, host),
      unwatch: (sub) =>
        void request({ type: 'unwatchChat', sub }, undefined, host).catch(() => undefined),
      canWatch: () =>
        AppState.currentState !== 'background' && latest.current.deviceId === host.deviceId,
      show: (detail) => latest.current.resource.put(detail, write),
      first: () => latest.current.resource.data?.messages[0]?.id,
      live: onLive,
      conversation: JSON.stringify([host.deviceId, chatId, subChatId]),
    });
    stream.start();
    live.current = stream;
    return () => {
      live.current = undefined;
      stream.stop();
    };
  }, [connection, request, chatId, subChatId, focused, away, onLive]);
  /** Takes a fresh copy of a live chat now; nothing while it is not live. */
  return useCallback(() => live.current?.refresh(), []);
}
