import { useEffect } from 'react';
import { trpc } from '@/lib/trpc';

/** Mirrors main's `chats:linked-projects-changed` payload (the renderer never imports main). */
type LinkedProjectsChanged = { chatId: string };

function isPayload(data: unknown): data is LinkedProjectsChanged {
  return typeof (data as Partial<LinkedProjectsChanged> | undefined)?.chatId === 'string';
}

/** Refetches a chat's `chats.get` when any window links or unlinks a project on it, so every
 *  window shows the same linked projects without a reload. */
export function useLinkedProjectsSync(): void {
  const utils = trpc.useUtils();

  useEffect(() => {
    return window.desktopApi?.on('chats:linked-projects-changed', (data) => {
      // A payload without a chat id must not widen into refetching every chat.
      if (isPayload(data)) void utils.chats.get.invalidate({ id: data.chatId });
    });
  }, [utils]);
}
