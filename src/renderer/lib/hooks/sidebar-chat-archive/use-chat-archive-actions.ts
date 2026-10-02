import { useAtomValue } from 'jotai';
import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { heldChatIdsAtom } from '../../stores/active-transport-registry';
import { extractErrorMessage } from '../../utils/error-message/extract-error-message';
import { useWindowEvent } from '../use-window-event';

type DeferToTaskAwareDialog = (chatId: string, operation: 'archive') => Promise<boolean>;
type ArchiveSingleChat = (chatId: string, options?: { killTerminals?: boolean }) => Promise<void>;

type UseArchiveWindowEventsOptions = {
  /** Active split pane's chat, else the selected chat; null on the split new-chat form. */
  focusedChatId: string | null;
  /** Work Queue / Flows / Settings cover the chat but keep its selection. */
  isChatCovered: boolean;
  loadingChatIds: ReadonlySet<string>;
  activeChats: ReadonlyArray<{ chatId: string; hasLiveFlowRun: boolean }> | undefined;
  deferToTaskAwareDialog: DeferToTaskAwareDialog;
  archiveSingleChat: ArchiveSingleChat;
  restoreChat: (chatId: string) => Promise<void>;
};

const reportArchiveFailure = (error: unknown) =>
  toast.error('Failed to archive chat', {
    description: extractErrorMessage(error) ?? 'Unable to archive this chat right now.',
  });

/** Row-action archive: hands off to the task-aware dialog when live linked tasks would be affected. */
export function useTaskAwareArchive(
  deferToTaskAwareDialog: DeferToTaskAwareDialog,
  archiveSingleChat: ArchiveSingleChat,
): (chatId: string) => Promise<void> {
  return useCallback(
    async (chatId: string) => {
      if (await deferToTaskAwareDialog(chatId, 'archive')) return;
      await archiveSingleChat(chatId).catch(reportArchiveFailure);
    },
    [deferToTaskAwareDialog, archiveSingleChat],
  );
}

/** The sidebar's archive requests that arrive as window events rather than row actions. */
export function useArchiveWindowEvents({
  focusedChatId,
  isChatCovered,
  loadingChatIds,
  activeChats,
  deferToTaskAwareDialog,
  archiveSingleChat,
  restoreChat,
}: UseArchiveWindowEventsOptions): void {
  const heldChatIds = useAtomValue(heldChatIdsAtom);

  // TaskAcceptBar's "Complete & Archive": its task is already completed, so this skips the
  // task-aware path; archiveSingleChat owns the pane-clear + deselect that closes the chat.
  useWindowEvent('sidebar:archive-chat', (event) => {
    const chatId = (event as CustomEvent<{ chatId?: string }>).detail?.chatId;
    if (!chatId) return;
    void archiveSingleChat(chatId).catch(reportArchiveFailure);
  });

  // Cmd+W auto-repeats keydown while held, and each repeat lands during the first archive's
  // async task preflight — so one hotkey archive in flight per chat.
  const inFlightRef = useRef(new Set<string>());
  const archiveFromHotkey = useCallback(
    async (chatId: string) => {
      const inFlight = inFlightRef.current;
      if (inFlight.has(chatId)) return;
      inFlight.add(chatId);
      try {
        if (await deferToTaskAwareDialog(chatId, 'archive')) return;
        // Restore can't revive killed terminals, so a reflexive keypress keeps them.
        await archiveSingleChat(chatId, { killTerminals: false });
        toast.success('Chat archived', {
          action: { label: 'Restore', onClick: () => void restoreChat(chatId) },
        });
      } catch (error) {
        reportArchiveFailure(error);
      } finally {
        inFlight.delete(chatId);
      }
    },
    [deferToTaskAwareDialog, archiveSingleChat, restoreChat],
  );

  // Archive aborts live turns and flow runs for good, so busy chats ask first. On mobile the
  // chat view unmounts the sidebar and this listener with it, so Cmd+W is a no-op there.
  useWindowEvent('sidebar:archive-focused-chat', () => {
    const chatId = focusedChatId;
    if (isChatCovered || !chatId) return;
    const isBusy =
      loadingChatIds.has(chatId) ||
      heldChatIds.has(chatId) ||
      (activeChats ?? []).some((chat) => chat.chatId === chatId && chat.hasLiveFlowRun);
    if (isBusy) {
      toast.warning('This chat is still running', {
        id: `archive-busy-${chatId}`,
        description: 'Archiving will stop it.',
        action: { label: 'Archive anyway', onClick: () => void archiveFromHotkey(chatId) },
      });
      return;
    }
    void archiveFromHotkey(chatId);
  });
}
