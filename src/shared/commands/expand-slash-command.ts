import { BUILTIN_COMMAND_NAMES } from './builtin-command-names';
import { fillCommandArguments } from './fill-command-arguments';

/** Matches `/commandName optional args` — dotAll so args can span multiple lines. */
export const SLASH_COMMAND_REGEX = /^\/(\S+)\s*(.*)$/s;

/**
 * True when `text` STARTS with a `/compact` invocation, optionally carrying the summarization
 * instructions the command accepts. Deliberately does not trim: callers pass the matched text
 * through unchanged, so accepting leading whitespace here would green-light a string that reaches
 * the provider off position 0 — the exact failure this predicate exists to prevent.
 *
 * Case-SENSITIVE for the same reason: the provider's own lookup compares with `===`
 * (claude-code commands.ts findCommand), so `/COMPACT` is not a command there. Accepting it here
 * would strip the user's attached context and then hand the provider something it rejects.
 *
 * The provider dispatches a built-in slash command only when the prompt STARTS with `/`, so any
 * text prepended ahead of it (mention tokens, attachment notices, injected plan context) turns
 * `/compact` into an ordinary message the model answers instead of a compaction. Callers use this
 * to suppress their own prefixes.
 *
 * Scoped to `compact` alone rather than every name in {@link BUILTIN_COMMAND_NAMES}: `/compact`
 * takes no context, while the others do — dropping the prefix from `/review` would silently
 * discard the file or selection the user deliberately attached.
 */
export function isCompactCommand(text: string): boolean {
  return text.match(SLASH_COMMAND_REGEX)?.[1] === 'compact';
}

export type CommandEntry = { name: string; path: string };

export type CommandFetcher = {
  listCommands: (projectPath: string | undefined) => Promise<CommandEntry[]>;
  getContent: (path: string) => Promise<string>;
};

/**
 * Expand a custom slash command in user input.
 *
 * - Parses `/commandName args` from the text
 * - Skips built-in commands (handled elsewhere)
 * - Fetches matching custom command content and replaces `$ARGUMENTS`
 * - Returns the original text unchanged if no expansion applies
 */
export async function expandSlashCommand(
  text: string,
  projectPath: string | undefined,
  fetcher: CommandFetcher,
): Promise<string> {
  const match = text.match(SLASH_COMMAND_REGEX);
  if (!match) return text;

  const [, commandName, args] = match;
  const builtinNames = new Set<string>(BUILTIN_COMMAND_NAMES);

  if (builtinNames.has(commandName.toLowerCase())) return text;

  try {
    const commands = await fetcher.listCommands(projectPath);
    const cmd = commands.find((c) => c.name.toLowerCase() === commandName.toLowerCase());

    if (cmd) {
      const content = await fetcher.getContent(cmd.path);
      return fillCommandArguments(content, args.trim());
    }
  } catch (_error) {
    // Keep original text when command lookup fails.
  }

  return text;
}
