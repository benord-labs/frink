import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { deliver } from '../../lib/chat/deliver';
import {
  STEER_REFUSED,
  STEER_UNREAD,
  addPending,
  changePending,
  hasUnreconciledSend,
  pendingKey,
  readPending,
  reconcile,
  removePending,
  steerMarkers,
  usePending,
  type PendingEntry,
} from '../../lib/chat/pending';
import { useAction, useConnection } from '../../lib/connection';
import { useDrafts } from '../../lib/drafts';
import type { Attachments } from './Composer/attach';
import { confirmChatDeletion, confirmDiscardMessage, confirmStopRun } from './confirm';

/**
 * Send, steer, stop and delete for one conversation. A message shows at once under its own id;
 * while a turn runs or a send is unconfirmed, a text-only message steers instead.
 */
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
  const { connection, request } = useConnection();
  const drafts = useDrafts();
  const key = pendingKey(connection?.deviceId, chatId, subChatId);
  const pending = usePending(key);
  const running = data?.activity === 'running';
  useEffect(() => {
    if (data) changePending(key, (entries) => reconcile(entries, data.messages, running));
  }, [key, data]);
  // What the computer took shows in the transcript on the next read, not the next poll.
  const sent = pending.filter((entry) => entry.state === 'sent').length;
  useEffect(() => {
    if (sent) refresh();
  }, [sent]);

  /** Steers are text-only, so a message with files always starts a turn. */
  function kindNow(files: number): PendingEntry['kind'] {
    return (running || hasUnreconciledSend(readPending(key))) && !files ? 'steer' : 'send';
  }

  /** How a new message goes now, noting the Steered notes a steer must not mistake for its own. */
  function route(text: string, files: number): Pick<PendingEntry, 'kind' | 'markers'> {
    const kind = kindNow(files);
    return { kind, markers: kind === 'steer' ? steerMarkers(data?.messages ?? [], text) : 0 };
  }

  function deliverEntry(entry: PendingEntry) {
    if (!subChatId) return;
    void deliver({ request, app: AppState }, { key, chatId, subChatId }, entry).then((reached) => {
      if (reached && entry.kind === 'steer')
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    });
  }

  function submit() {
    if (!subChatId) return;
    const { value, requestId } = drafts.get(draft, '');
    const files = attachments.files;
    drafts.clear(draft, requestId);
    attachments.clear();
    const entry: PendingEntry = {
      id: requestId,
      text: value,
      attachments: files,
      ...route(value, files.length),
      state: 'sending',
    };
    changePending(key, (entries) => addPending(entries, entry));
    deliverEntry(entry);
    onSent();
  }

  /**
   * A failed message is asked again under its own id and kind, so a lost answer never posts twice.
   * A steer the agent never got goes again under a fresh id, as whatever the chat takes now.
   */
  function retry(id: string) {
    const entry = readPending(key).find((item) => item.id === id);
    if (entry?.state !== 'failed') return;
    if (entry.error !== STEER_REFUSED && entry.error !== STEER_UNREAD) return deliverEntry(entry);
    const next = { ...entry, id: Crypto.randomUUID(), ...route(entry.text, 0) };
    changePending(key, (entries) => entries.map((item) => (item.id === id ? next : item)));
    deliverEntry(next);
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
    pending,
    submit,
    retry,
    discard: (id: string) => void discard(id),
    stop: () => void stop(),
    remove,
  };
}
