/**
 * The [/cmd:name]...[/cmd-end] delimiter format that carries a selected command's body through the
 * editor, the sent message and expandSlashCommand. Shared so main and renderer read one definition.
 */

/** Valid characters in a command name (supports namespaced commands like git:commit) */
const CMD_NAME_CHARS = '[a-zA-Z0-9_:-]+';

/** Wrap command text with delimiters for serialization */
export function encodeCommandBlock(name: string, content: string): string {
  return `[/cmd:${name}]\n${content}\n[/cmd-end]\n`;
}

/** Global: iterate every block in serialized text (buildContentFromSerialized). Reset `.lastIndex = 0` first. */
export const CMD_BLOCK_SERIALIZE_REGEX = new RegExp(
  `\\[\\/cmd:(${CMD_NAME_CHARS})\\]\\n([\\s\\S]*?)\\n\\[\\/cmd-end\\]\\n?`,
  'g',
);

/**
 * Regex to find a single [/cmd:name]...[/cmd-end] block in a message.
 * Non-global — use with `.exec()` to extract name, content, and surrounding text.
 */
export const CMD_BLOCK_MESSAGE_REGEX = new RegExp(
  `(?:^|\\n)?\\[\\/cmd:(${CMD_NAME_CHARS})\\]\\n([\\s\\S]*?)\\n\\[\\/cmd-end\\]\\n?`,
);
