import { startsWithCommand } from '../../../../../shared/commands/expand-slash-command';
import { formatPromptWithHistory } from './prompt-history';

/** Sub-chat → a person's messages no provider turn took, so a resumed session never saw them.
 * In memory: a restart drops them. */
const undeliveredBySubChat = new Map<string, string[]>();

export function clearUndeliveredMessagesForTests(): void {
  undeliveredBySubChat.clear();
}

/** Notes a person's message as owed until the provider takes its prompt (`accepted`), and returns
 * the prompt with what earlier stopped turns still owe as transcript. A slash command goes out bare
 * and is never owed: a Claude local command (`/clear`) never fires the prompt hook that takes it.
 * Owed messages are kept as typed, tokens and all, so their transcript can recap what was attached;
 * `prompt` is the message as this turn sends it. */
export function carryUndeliveredMessages(
  subChatId: string,
  { raw, prompt }: { raw: string; prompt: string },
  personAuthored: boolean,
) {
  const isCommand = startsWithCommand(prompt);
  const owed = undeliveredBySubChat.get(subChatId) ?? [];
  // A retry re-sends the same text, which then arrives as the prompt itself.
  const earlier = isCommand ? [] : owed.filter((sent) => sent !== raw);
  if (personAuthored && !isCommand) undeliveredBySubChat.set(subChatId, [...earlier, raw]);
  let taken = false;
  return {
    prompt: formatPromptWithHistory(
      prompt,
      earlier.map((content) => ({ role: 'user' as const, content, personAuthored: true as const })),
    ),
    // Once and by value: a later prompt hook, or a newer send's own message, must clear no more.
    accepted: () => {
      if (taken) return;
      taken = true;
      const delivered = new Set([...earlier, raw]);
      const rest = (undeliveredBySubChat.get(subChatId) ?? []).filter(
        (sent) => !delivered.has(sent),
      );
      if (rest.length > 0) undeliveredBySubChat.set(subChatId, rest);
      else undeliveredBySubChat.delete(subChatId);
    },
  };
}
