import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { changePending, readPending, removePending } from '../../lib/chat/pending';
import { useOutbox } from '../../lib/chat/use-outbox';
import { useAction } from '../../lib/connection';
import { useDrafts } from '../../lib/drafts';
import type { Attachments } from './Composer/attach';
import { confirmChatDeletion, confirmDiscardMessage, confirmStopRun } from './confirm';

/** Send, steer, stop and delete for one conversation; messages go out through its outbox. */
export function useChatActions({
  chatId,
  subChatId,
  data,
  draft,
  attachments,
  flowRun,
  refresh,
  onSent,
  onDeleted,
}: {
  chatId: string;
  subChatId: string | undefined;
  data: MobileChatDetail | undefined;
  /** The draft the composer edits, read only when sending. */
  draft: string;
  attachments: Attachments;
  flowRun: boolean;
  refresh: () => void;
  onSent: () => void;
  onDeleted: () => void;
}) {
  const action = useAction();
  const drafts = useDrafts();
  const outbox = useOutbox({ chatId, subChatId, data, refresh });
  const { key } = outbox;

  function submit() {
    if (!subChatId) return;
    const { value, requestId } = drafts.get(draft, '');
    const files = attachments.files;
    drafts.clear(draft, requestId);
    attachments.clear();
    void outbox.post(requestId, value, files);
    onSent();
  }

  async function discard(id: string) {
    if (!(await confirmDiscardMessage())) return;
    // A retry tapped while the dialog was open may be on its way; that one is no longer failed.
    const entry = readPending(key).find((item) => item.id === id);
    if (entry?.state === 'failed') changePending(key, (entries) => removePending(entries, id));
  }

  async function stop() {
    if (!subChatId) return;
    if (flowRun && !(await confirmStopRun())) return;
    if (await action.run({ type: 'stopChat', chatId, subChatId })) refresh();
  }

  async function remove() {
    if (!(await confirmChatDeletion(data?.chat.name ?? 'this chat'))) return;
    if (await action.run({ type: 'deleteChat', chatId })) onDeleted();
  }

  const note = action.error ? { text: action.error, error: true } : null;

  return {
    busy: action.busy,
    note,
    pending: outbox.pending,
    submit,
    retry: outbox.retry,
    discard: (id: string) => void discard(id),
    stop: () => void stop(),
    remove,
  };
}
