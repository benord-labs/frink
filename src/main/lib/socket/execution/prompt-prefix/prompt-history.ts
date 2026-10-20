import {
  isCompactCommand,
  startsWithCommand,
} from '../../../../../shared/commands/expand-slash-command';
import type { ConversationTurn } from '../../../../../shared/types/execution';
import { recapComposerTokens } from './composer-context';

/** ≈50k tokens at ~4 chars/token: a quarter of the smallest target window leaves room to work. */
const HISTORY_BUDGET_CHARS = 200_000;
const MESSAGE_BOUNDARY_RE = /\n\n(?=(?:Human|Assistant): )/;

/** Keeps the newest history within budget, cut at a message boundary, and says what was dropped. */
function keepRecentHistory(historyText: string): string {
  if (historyText.length <= HISTORY_BUDGET_CHARS) return historyText;
  const tail = historyText.slice(-HISTORY_BUDGET_CHARS);
  const boundary = tail.search(MESSAGE_BOUNDARY_RE);
  const kept = boundary >= 0 ? tail.slice(boundary + 2) : tail;
  const omitted = historyText.length - kept.length;
  return `[Earlier conversation omitted to fit the context budget: ${omitted} characters]\n\n${kept}`;
}

/** The prompt goes out bare: a slash command the provider runs from text, which `/compact` always
 * is; any other only where `commandFirst` (a runtime with no text command layer reads it as text). */
export function keepsCommandFirst(prompt: string, commandFirst: boolean): boolean {
  return commandFirst ? startsWithCommand(prompt) : isCompactCommand(prompt);
}

/** The prompt carries the transcript: there is one, and the prompt need not stay bare. */
export function carriesHistory(
  prompt: string,
  history?: ConversationTurn[],
  commandFirst = true,
): boolean {
  return Boolean(history?.length) && !keepsCommandFirst(prompt, commandFirst);
}

/**
 * Wraps a prompt with the renderer-supplied transcript when the provider will NOT replay
 * history natively (fresh sessions, and the resume-failure fallback that degrades a
 * failed native resume to a fresh query). Native Claude/Codex resumes skip this — the
 * session already owns the transcript, and shipping it again duplicates it.
 *
 * A slash command is returned bare (see keepsCommandFirst): the provider only dispatches one at
 * position 0. The transcript it goes out without is owed to a later turn (carryUndeliveredMessages).
 *
 * A person's turns carry their composer tokens as recaps, before the budget cut; every other turn
 * is replayed exactly as stored.
 */
export function formatPromptWithHistory(
  currentPrompt: string,
  history?: ConversationTurn[],
  commandFirst = true,
): string {
  if (!history || !carriesHistory(currentPrompt, history, commandFirst)) return currentPrompt;

  const historyText = keepRecentHistory(
    history
      .map((msg) => {
        const role = msg.role === 'user' ? 'Human' : 'Assistant';
        return `${role}: ${msg.personAuthored ? recapComposerTokens(msg.content) : msg.content}`;
      })
      .join('\n\n'),
  );

  return `<conversation_history>
${historyText}
</conversation_history>

Continue the conversation. The user's latest message is:
${currentPrompt}`;
}

/** A resume prompt for a session that starts fresh after all: `fresh` replaces `carried`, the tail
 * a native resume would have sent. With no transcript it is kept whole. */
export function replaceCarriedWithHistory(
  prompt: string,
  carried: string,
  fresh: string,
  history?: ConversationTurn[],
): string {
  if (!history?.length || !prompt.endsWith(carried)) return prompt;
  return `${prompt.slice(0, prompt.length - carried.length)}${fresh}`;
}
