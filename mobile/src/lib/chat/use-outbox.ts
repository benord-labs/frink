import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { useConnection } from '../connection';
import { deliver } from './deliver';
import {
  STEER_REFUSED,
  STEER_UNREAD,
  addPending,
  changePending,
  hasUnreconciledSend,
  pendingKey,
  readPending,
  reconcile,
  steerMarkers,
  usePending,
  type PendingEntry,
  type PendingFile,
} from './pending';

/**
 * One conversation's outgoing messages. Each shows at once under its own id; while a turn runs or
 * a send is unconfirmed, a text-only message steers instead of starting a turn.
 */
export function useOutbox({
  chatId,
  subChatId,
  data,
  refresh,
}: {
  chatId: string;
  subChatId: string | undefined;
  data: MobileChatDetail | undefined;
  refresh: () => void;
}) {
  const { connection, request } = useConnection();
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

  /** Resolves true once the computer has it. */
  async function deliverEntry(entry: PendingEntry) {
    if (!subChatId) return false;
    const reached = await deliver({ request, app: AppState }, { key, chatId, subChatId }, entry);
    if (reached && entry.kind === 'steer')
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    return reached;
  }

  /** Shows the message now and sends or steers it under `id`, chosen as it is posted. */
  function post(id: string, text: string, attachments: PendingFile[] = []) {
    if (!subChatId) return Promise.resolve(false);
    const entry: PendingEntry = {
      id,
      text,
      attachments,
      ...route(text, attachments.length),
      state: 'sending',
    };
    changePending(key, (entries) => addPending(entries, entry));
    return deliverEntry(entry);
  }

  /**
   * A failed message is asked again under its own id and kind, so a lost answer never posts twice.
   * A steer the agent never got goes again under a fresh id, as whatever the chat takes now.
   */
  function retry(id: string) {
    const entry = readPending(key).find((item) => item.id === id);
    if (entry?.state !== 'failed') return;
    if (entry.error !== STEER_REFUSED && entry.error !== STEER_UNREAD)
      return void deliverEntry(entry);
    const next = { ...entry, id: Crypto.randomUUID(), ...route(entry.text, 0) };
    changePending(key, (entries) => entries.map((item) => (item.id === id ? next : item)));
    void deliverEntry(next);
  }

  return { key, pending, post, retry };
}
