import { useRef, useState } from 'react';
import { useAction, useConnection } from '../../lib/connection';
import { requestMobile, type Connection } from '../../lib/api';
import type { NewChatPreferences } from '../../lib/preferences';

type Choice = NewChatPreferences & { projectId: string };
export type StartedChat = { chatId: string; subChatId: string };

/**
 * Cleanup survives leaving the page, but can never follow a newly paired computer. It is asked
 * once and never retried: a later removal could take a chat that has been used since.
 */
function removeUnusedChat(connection: Connection, chatId: string) {
  requestMobile(connection, { type: 'deleteChat', chatId }).catch(() => {});
}

/**
 * Makes a new chat's chat on the Mac the first time it is needed (its first message, or its model
 * list), then claims it for that first message. Once made, the chat is reused: a retry never
 * makes another.
 */
export function useStartChat() {
  const action = useAction();
  const { connection } = useConnection();
  const [created, setCreated] = useState<StartedChat | null>(null);
  const owned = useRef<{ chat: StartedChat | null; sent: boolean }>({ chat: null, sent: false });
  const generation = useRef(0);
  const pending = useRef<{
    generation: number;
    choiceKey: string;
    promise: Promise<StartedChat | undefined>;
  } | null>(null);

  const gone = useRef(false);
  // The Mac that made the owned chat: pairing another one must not send it this chat's removal.
  const madeOn = useRef<Connection | null>(null);
  const remove = (chat: StartedChat, on = madeOn.current) => {
    if (on) removeUnusedChat(on, chat.chatId);
  };

  function create(choice: Choice): Promise<StartedChat | undefined> {
    if (gone.current) return Promise.resolve(undefined);
    if (owned.current.chat) return Promise.resolve(owned.current.chat);
    const previous = pending.current;
    const choiceKey = JSON.stringify([choice.projectId, choice.useWorktree, choice.mode]);
    if (previous?.generation === generation.current && previous.choiceKey !== choiceKey) discard();
    const revision = generation.current;
    if (previous?.generation === revision) return previous.promise;
    const making = (async () => {
      // A changed project waits for the retired request to release the action lock.
      if (previous) await previous.promise;
      if (gone.current || revision !== generation.current) return undefined;
      const on = connection;
      const made = await action.run({ type: 'createChat', ...choice });
      if (!made) return undefined;
      if (gone.current || revision !== generation.current) return void remove(made, on);
      madeOn.current = on;
      owned.current.chat = made;
      setCreated(made);
      return made;
    })();
    const promise = making.finally(() => {
      if (pending.current?.promise === promise) pending.current = null;
    });
    pending.current = { generation: revision, choiceKey, promise };
    return promise;
  }

  /** Keeps the chat for its first message, which may arrive even if its answer is lost. */
  function claim(chat: StartedChat): boolean {
    // A chat retired while the caller waited (the project changed) takes no message, and a
    // double tap sends one.
    if (gone.current || owned.current.chat !== chat || owned.current.sent) return false;
    owned.current.sent = true;
    return true;
  }

  /** Removes a chat that was made only to list models and never used, on the Mac too. */
  function discard() {
    const { chat, sent } = owned.current;
    if (sent) return;
    generation.current++;
    owned.current.chat = null;
    setCreated(null);
    if (chat) remove(chat);
  }
  /** Leaving the page: drop the unused chat, and any chat still on its way. */
  function leave() {
    gone.current = true;
    discard();
  }

  return {
    create,
    claim,
    discard,
    leave,
    created,
    busy: action.busy,
    error: action.error,
  };
}
