import { useCallback, useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import { extractErrorMessage } from '../../utils/error-message/extract-error-message';
import { useWindowEvent } from '../use-window-event';

type ArchiveSingleChat = (chatId: string) => Promise<void>;

type UseArchiveWindowEventsOptions = {
  /** Active split pane's chat, else the selected chat. The new-chat pane's sentinel is not a chat. */
  focusedChatId: string | null;
  /** Work Queue / Flows / Settings cover the chat but keep its selection. */
  isChatCovered: boolean;
  archiveSingleChat: ArchiveSingleChat;
  restoreChat: (chatId: string) => Promise<void>;
};

const reportArchiveFailure = (reason: string | null) =>
  toast.error('Failed to archive chat', {
    description: reason ?? 'Unable to archive this chat right now.',
  });

/** Row-action archive; the main process stops the chat's linked task or refuses the archive. */
export function useChatArchive(
  archiveSingleChat: ArchiveSingleChat,
): (chatId: string) => Promise<void> {
  return useCallback(
    async (chatId: string) => {
      await archiveSingleChat(chatId).catch((error) =>
        reportArchiveFailure(extractErrorMessage(error)),
      );
    },
    [archiveSingleChat],
  );
}

/** The sidebar's archive requests that are not row actions. Returns the archive-shortcut handler. */
export function useArchiveWindowEvents(options: UseArchiveWindowEventsOptions): () => void {
  // Synced at commit, so a handler captured in an earlier render still archives the chat that is
  // focused now, never the previously focused or a covered one.
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  // TaskAcceptBar's "Complete & Archive"; archiveSingleChat owns the pane-clear + deselect.
  useWindowEvent('sidebar:archive-chat', (event) => {
    // SAFETY: this event is only ever dispatched as a CustomEvent whose detail carries `chatId`.
    const chatId = (event as CustomEvent<{ chatId?: string }>).detail?.chatId;
    if (!chatId) return;
    void latest.current
      .archiveSingleChat(chatId)
      .catch((error) => reportArchiveFailure(extractErrorMessage(error)));
  });

  // One hotkey archive at a time: a second press while one is settling could otherwise archive
  // the chat that takes focus next.
  const inFlightRef = useRef(false);
  const archiveFromHotkey = useCallback(async (chatId: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const { archiveSingleChat, restoreChat } = latest.current;
    try {
      await archiveSingleChat(chatId);
      toast.success('Chat archived', {
        action: { label: 'Restore', onClick: () => void restoreChat(chatId) },
      });
    } catch (error) {
      reportArchiveFailure(extractErrorMessage(error));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  return useCallback(() => {
    const { focusedChatId, isChatCovered } = latest.current;
    if (isChatCovered || !focusedChatId) return;
    void archiveFromHotkey(focusedChatId);
  }, [archiveFromHotkey]);
}
