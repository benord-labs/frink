import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import type { MobileChatDetail } from '../../../../src/shared/types/remote/mobile';
import { useAction } from '../../lib/connection';
import type { useDraft } from '../../lib/drafts';
import type { Attachments } from './Composer/attach';
import { STEER_NOT_DELIVERED } from './chat-state';
import { confirmChatDeletion, confirmStopRun } from './confirm';

type Draft = ReturnType<typeof useDraft<string>>;

/**
 * Send, steer, stop and delete for one conversation.
 * A send keeps its request id until the computer acknowledges it, so a retry after a lost
 * response can't post twice. A steer that wasn't delivered stays in the box with a new id: the
 * computer remembers outcomes by id, and nothing was sent.
 */
export function useChatActions({
  chatId,
  data,
  draft,
  attachments,
  flowRun,
  refresh,
  onSent,
  onDeleted,
}: {
  chatId: string;
  data: MobileChatDetail | undefined;
  draft: Draft;
  attachments: Attachments;
  flowRun: boolean;
  refresh: () => void;
  onSent: () => void;
  onDeleted: () => void;
}) {
  const action = useAction();
  const [undelivered, setUndelivered] = useState(false);
  const subChatId = data?.subChatId;
  const idle = data?.activity === 'idle';
  // The note describes the last steer attempt; a new conversation or Frink finishing clears it.
  useEffect(() => setUndelivered(false), [subChatId, idle]);
  // A send whose response was lost is acknowledged by the transcript: the saved message carries the
  // draft's request id. Clearing here stops a retry going out again, e.g. as a steer once running.
  const acknowledged = !!data?.messages.some((message) => message.id === draft.requestId);
  useEffect(() => {
    if (!acknowledged) return;
    draft.clear(draft.requestId);
    attachments.clear();
  }, [acknowledged]);

  async function send() {
    if (!subChatId) return;
    const sent = await action.run({
      type: 'sendMessage',
      chatId,
      subChatId,
      text: draft.value,
      requestId: draft.requestId,
      ...(attachments.ids.length ? { attachments: attachments.ids } : {}),
    });
    if (!sent) return;
    draft.clear(draft.requestId);
    attachments.clear();
    onSent();
    refresh();
  }

  async function steer() {
    if (!subChatId) return;
    const result = await action.run({
      type: 'steerMessage',
      chatId,
      subChatId,
      requestId: draft.requestId,
      text: draft.value.trim(),
    });
    if (!result) return;
    if (result.outcome === 'not-delivered') {
      setUndelivered(true);
      draft.update(draft.value);
      return;
    }
    setUndelivered(false);
    draft.clear(draft.requestId);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onSent();
    refresh();
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

  const running = data?.activity === 'running';
  const note = action.error
    ? { text: action.error, error: true }
    : undelivered && running
      ? { text: STEER_NOT_DELIVERED }
      : data?.activity === 'background' && draft.value.trim()
        ? { text: 'Kept until the background work finishes.' }
        : null;

  return {
    busy: action.busy,
    note,
    submit: () => void (running ? steer() : send()),
    stop: () => void stop(),
    remove: () => void remove(),
  };
}
