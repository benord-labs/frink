import { isCompactCommand } from '../../../../../shared/commands/expand-slash-command';
import { formatPromptWithHistory } from './prompt-history';

/** Sub-chat → a person's messages no provider turn took, so a resumed session never saw them.
 * In memory: a restart drops them. */
const undeliveredBySubChat = new Map<string, string[]>();

export function clearUndeliveredMessagesForTests(): void {
  undeliveredBySubChat.clear();
}

/** Notes a person's message as owed until the provider takes its prompt (`accepted`), and returns
 * the prompt with what earlier stopped turns still owe as transcript. `/compact` goes out bare. */
export function carryUndeliveredMessages(
  subChatId: string,
  message: string,
  personAuthored: boolean,
) {
  const isCommand = isCompactCommand(message);
  const owed = undeliveredBySubChat.get(subChatId) ?? [];
  // A retry re-sends the same text, which then arrives as the prompt itself.
  const earlier = isCommand ? [] : owed.filter((sent) => sent !== message);
  if (personAuthored && !isCommand) undeliveredBySubChat.set(subChatId, [...earlier, message]);
  let taken = false;
  return {
    prompt: formatPromptWithHistory(
      message,
      earlier.map((content) => ({ role: 'user' as const, content })),
    ),
    // Once and by value: a later prompt hook, or a newer send's own message, must clear no more.
    accepted: () => {
      if (taken) return;
      taken = true;
      const delivered = new Set([...earlier, message]);
      const rest = (undeliveredBySubChat.get(subChatId) ?? []).filter(
        (sent) => !delivered.has(sent),
      );
      if (rest.length > 0) undeliveredBySubChat.set(subChatId, rest);
      else undeliveredBySubChat.delete(subChatId);
    },
  };
}
