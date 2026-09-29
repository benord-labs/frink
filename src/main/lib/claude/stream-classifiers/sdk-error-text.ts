/**
 * The Agent SDK appends the CLI's stderr tail to its process-exit errors ("Claude Code process
 * exited with code 1. stderr: …"), but only when it spawns the CLI itself. Stderr may carry remote
 * MCP credentials (see session-spec.ts), and its free text would steer the substring classifiers,
 * so the tail is removed before an exit error is classified or logged. The match is keyed on the
 * SDK's exit phrase rather than the start of the string, so the same exit message is also cleaned
 * when nested in "Cannot write to process that exited with error: …".
 */
const SDK_STDERR_TAIL =
  /(Claude Code process (?:exited with code -?\d+|terminated by signal \w+))\. stderr: [\s\S]*$/;

/** An SDK failure's message, without the CLI stderr tail. */
export function claudeErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(SDK_STDERR_TAIL, '$1');
}
