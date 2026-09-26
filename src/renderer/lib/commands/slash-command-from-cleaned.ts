/**
 * Regex-only extraction of [/cmd:name]...[/cmd-end] from text already processed
 * by extractTextMentions. Keeps command-block-format isolated from render-file-mentions.
 */

import { CMD_BLOCK_MESSAGE_REGEX } from '@/lib/commands/command-block-format';

export type SlashCommandFromCleaned = {
  commandName: string | null;
  commandText: string | null;
  cleanedText: string | null;
};

export function parseSlashCommandFromCleanedText(rawCleanedText: string): SlashCommandFromCleaned {
  const match = CMD_BLOCK_MESSAGE_REGEX.exec(rawCleanedText);
  if (match && match.index !== undefined) {
    const before = rawCleanedText.slice(0, match.index).trim();
    const after = rawCleanedText.slice(match.index + match[0].length).trim();
    const surrounding = [before, after].filter(Boolean).join('\n');
    return {
      commandName: match[1],
      commandText: match[2],
      cleanedText: surrounding || null,
    };
  }
  return { commandName: null, commandText: null, cleanedText: rawCleanedText };
}
