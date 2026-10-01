import { useState } from 'react';
import { useAction } from '../../lib/connection';
import type { NewChatPreferences } from '../../lib/preferences';

type Choice = NewChatPreferences & { projectId: string };
export type StartedChat = { chatId: string; subChatId: string };

/**
 * Creates a chat, then sends its first message. If the message fails after the chat exists, a
 * retry with the same project, location and mode reuses that chat instead of making another.
 */
export function useStartChat() {
  const action = useAction();
  const [created, setCreated] = useState<(StartedChat & { key: string }) | null>(null);
  const [starting, setStarting] = useState(false);

  async function chatFor(choice: Choice) {
    const key = `${choice.projectId}:${choice.useWorktree}:${choice.mode}`;
    if (created?.key === key) return created;
    const made = await action.run({ type: 'createChat', ...choice });
    if (!made) return undefined;
    const chat = { key, ...made };
    setCreated(chat);
    return chat;
  }

  async function start(
    choice: Choice,
    text: string,
    requestId: string,
  ): Promise<StartedChat | undefined> {
    setStarting(true);
    try {
      const chat = await chatFor(choice);
      if (!chat) return undefined;
      const { chatId, subChatId } = chat;
      const sent = await action.run({ type: 'sendMessage', chatId, subChatId, text, requestId });
      return sent ? { chatId, subChatId } : undefined;
    } finally {
      setStarting(false);
    }
  }

  return {
    start,
    starting,
    error: action.error,
    /** The chat that exists although its first message failed, so the user can still open it. */
    orphan: action.error && !starting ? created : null,
  };
}
