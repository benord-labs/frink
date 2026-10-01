import { isCompactCommand } from '../../../../../shared/commands/expand-slash-command';

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

/**
 * Wraps a prompt with the renderer-supplied transcript when the provider will NOT replay
 * history natively (fresh sessions, and the resume-failure fallback that degrades a
 * failed native resume to a fresh query). Native Claude/Codex resumes skip this — the
 * session already owns the transcript, and shipping it again duplicates it.
 *
 * A `/compact` prompt is returned bare: it only dispatches at position 0 (see isCompactCommand),
 * and it acts on the session rather than on prompt content, so the transcript it would carry is
 * exactly what compaction is about to discard.
 */
export function formatPromptWithHistory(
  currentPrompt: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history || history.length === 0 || isCompactCommand(currentPrompt)) {
    return currentPrompt;
  }

  const historyText = keepRecentHistory(
    history
      .map((msg) => {
        const role = msg.role === 'user' ? 'Human' : 'Assistant';
        return `${role}: ${msg.content}`;
      })
      .join('\n\n'),
  );

  return `<conversation_history>
${historyText}
</conversation_history>

Continue the conversation. The user's latest message is:
${currentPrompt}`;
}
