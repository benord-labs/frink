/**
 * Detects Claude Agent SDK / Claude Code CLI errors where resuming a session is impossible
 * (missing JSONL, invalid UUID, etc.). Used to retry once without `resume` / `continue`.
 */
export function isResumeFailureText(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return (
    normalized.includes('session not found') ||
    normalized.includes('invalid session') ||
    normalized.includes('unknown session') ||
    normalized.includes('no conversation found') ||
    normalized.includes('failed to resume') ||
    normalized.includes('unable to resume') ||
    normalized.includes('could not resume') ||
    normalized.includes('can not resume') ||
    normalized.includes('cannot resume') ||
    normalized.includes('error resuming') ||
    normalized.includes('resume failed')
  );
}
