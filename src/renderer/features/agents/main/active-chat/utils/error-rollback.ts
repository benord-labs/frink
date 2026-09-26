import type { UIMessage } from 'ai';

export function pruneFailedExecutionShell(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;

  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role !== 'assistant') {
    return messages;
  }

  const parts = lastMessage.parts ?? [];
  const hasMeaningfulContent = parts.some(
    (part: { type: string; text?: string; toolCallId?: string }) =>
      (part.type === 'text' && !!part.text?.trim()) || part.toolCallId != null,
  );

  if (hasMeaningfulContent) {
    return messages;
  }

  // Keep the failed user turn visible; only remove an empty assistant shell.
  return messages.slice(0, -1);
}
