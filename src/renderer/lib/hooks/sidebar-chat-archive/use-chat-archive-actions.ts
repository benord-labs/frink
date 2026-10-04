import { useCallback, useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import { extractErrorMessage } from '../../utils/error-message/extract-error-message';
import { useWindowEvent } from '../use-window-event';

type DeferToTaskAwareDialog = (chatId: string, operation: 'archive') => Promise<boolean>;
type ArchiveSingleChat = (chatId: string, options?: { killTerminals?: boolean }) => Promise<void>;

type UseArchiveWindowEventsOptions = {
  /** Active split pane's chat, else the selected chat. The new-chat pane's sentinel is not a chat. */
  focusedChatId: string | null;
  /** Work Queue / Flows / Settings cover the chat but keep its selection. */
  isChatCovered: boolean;
  deferToTaskAwareDialog: DeferToTaskAwareDialog;
  archiveSingleChat: ArchiveSingleChat;
  restoreChat: (chatId: string) => Promise<void>;
};

const reportArchiveFailure = (reason: string | null) =>
  toast.error('Failed to archive chat', {
    description: reason ?? 'Unable to archive this chat right now.',
  });

/** Row-action archive: hands off to the task-aware dialog when live linked tasks would be affected. */
export function useTaskAwareArchive(
  deferToTaskAwareDialog: DeferToTaskAwareDialog,
  archiveSingleChat: ArchiveSingleChat,
): (chatId: string) => Promise<void> {
  return useCallback(
    async (chatId: string) => {
      if (await deferToTaskAwareDialog(chatId, 'archive')) return;
      await archiveSingleChat(chatId).catch((error) =>
        reportArchiveFailure(extractErrorMessage(error)),
      );
    },
    [deferToTaskAwareDialog, archiveSingleChat],
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

  // TaskAcceptBar's "Complete & Archive": its task is already completed, so this skips the
  // task-aware path; archiveSingleChat owns the pane-clear + deselect that closes the chat.
  useWindowEvent('sidebar:archive-chat', (event) => {
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
    const { deferToTaskAwareDialog, archiveSingleChat, restoreChat } = latest.current;
    try {
      // Same rule as the row action: a chat whose linked task is still working asks first.
      if (await deferToTaskAwareDialog(chatId, 'archive')) return;
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
