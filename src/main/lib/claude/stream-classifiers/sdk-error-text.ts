import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

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

/** The error the one-shot SDK throws for a failed result frame, which a warm turn must raise itself.
 * An `is_error` success (usage-limit or API text) stays with the trailing-text classifiers. */
export function failedResultError(msg: SDKMessage): Error | undefined {
  if (msg.type !== 'result' || !msg.is_error || msg.subtype === 'success') return undefined;
  const errors = msg.errors
    .map((e) => e.trim())
    .filter(Boolean)
    .join('; ');
  return new Error(`Claude Code returned an error result: ${errors || msg.subtype}`);
}
