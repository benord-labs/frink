/**
 * Parses serialized user message text for slash-command block display (queue row, chat bubble).
 * Must stay aligned with AgentUserMessageBubble: extractTextMentions first, then CMD block regex.
 *
 * Lives in its own module (not command-block-format.ts) to avoid importing render-file-mentions
 * from command-block-format — that would cycle via agents-mentions-editor.
 */

import { parseSlashCommandFromCleanedText } from '@/lib/commands/slash-command-from-cleaned';
import { extractTextMentions } from '../mentions/render-file-mentions';

export type SlashCommandDisplayParts = {
  textMentions: ReturnType<typeof extractTextMentions>['textMentions'];
  commandName: string | null;
  commandText: string | null;
  cleanedText: string | null;
};

/** Full pipeline: mention stripping, then slash-command block extraction. */
export function parseSlashCommandDisplayParts(rawMessage: string): SlashCommandDisplayParts {
  const { textMentions, cleanedText: rawCleanedText } = extractTextMentions(rawMessage);
  const cmd = parseSlashCommandFromCleanedText(rawCleanedText);
  return { textMentions, ...cmd };
}
