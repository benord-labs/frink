import {
  SLASH_COMMAND_REGEX,
  startsWithCommand,
} from '../../../../../shared/commands/expand-slash-command';
import type { ConversationTurn } from '../../../../../shared/types/execution';
import { carriesHistory, formatPromptWithHistory, keepsCommandFirst } from './prompt-history';

/** Sub-chat → a person's messages no provider turn took, so a resumed session never saw them.
 * In memory: a restart drops them. */
const undeliveredBySubChat = new Map<string, string[]>();

/** A transcript a slash command went out without: the session it was sent on (null: fresh), and
 * the owed messages already waiting then, which the transcript holds. */
type OwedTranscript = { turns: ConversationTurn[]; session: string | null; covered: Set<string> };

/** Sub-chat → the transcript a command left behind, owed to the next turn on a newer session.
 * In memory: a restart drops it. */
const owedTranscriptBySubChat = new Map<string, OwedTranscript>();

/** Claude's `/clear` and its aliases start the conversation over: nothing is owed after them. */
const CLEARS_CONVERSATION = new Set(['clear', 'reset', 'new']);

export function clearUndeliveredMessagesForTests(): void {
  undeliveredBySubChat.clear();
  owedTranscriptBySubChat.clear();
}

/** Drops `entry` once its turn reaches the provider, unless a newer transcript replaced it. */
function release(subChatId: string, entry: OwedTranscript | undefined): void {
  if (entry && owedTranscriptBySubChat.get(subChatId) === entry) {
    owedTranscriptBySubChat.delete(subChatId);
  }
}

/** Notes a person's message as owed until the provider takes its prompt (`accepted`), and builds
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
  const clears = CLEARS_CONVERSATION.has(prompt.match(SLASH_COMMAND_REGEX)?.[1] ?? '');
  let taken = false;
  let bare = false;
  // The owed transcript this turn replays or clears, dropped once the provider has the turn.
  let ends: OwedTranscript | undefined;
  return {
    /** The prompt for a resumed session (`carried`) and a fresh one. A command sent bare notes the
     * transcript it skips; the next turn on another session replays it. */
    promptsFor: (
      continued: string | null | undefined,
      history: ConversationTurn[] | undefined,
      commandFirst: boolean,
    ) => {
      const session = continued || null;
      const fresh = formatPromptWithHistory(prompt, history, commandFirst);
      const freshCarriesHistory = carriesHistory(prompt, history, commandFirst);
      bare = keepsCommandFirst(prompt, commandFirst);
      const owedNow = owedTranscriptBySubChat.get(subChatId);
      ends = bare && !clears ? undefined : owedNow;
      if (bare) {
        // Taken on the session this turn continues, an older copy is superseded by the newer one.
        if (!clears && history?.length && (!owedNow || owedNow.session === session)) {
          owedTranscriptBySubChat.set(subChatId, {
            turns: history,
            session,
            covered: new Set(owed),
          });
        }
        return { carried: prompt, fresh, freshCarriesHistory };
      }
      const replay = ends && session !== null && session !== ends.session ? ends : null;
      const replayed = [
        ...(replay?.turns ?? []),
        ...earlier
          .filter((content) => !replay?.covered.has(content))
          .map((content) => ({ role: 'user' as const, content, personAuthored: true as const })),
      ];
      const carried = formatPromptWithHistory(prompt, replayed, commandFirst);
      return { carried, fresh, freshCarriesHistory };
    },
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
      release(subChatId, ends);
    },
    /** The CLI has the prompt: a Claude local command such as `/clear` is never taken by the hook. */
    pushed: () => {
      if (bare && clears) release(subChatId, ends);
    },
  };
}
