import log from 'electron-log';
import { detectCodexAccount } from './detect-codex';

/**
 * Message to show when the `codex` binary has no login on this machine, else null. Call it
 * before taking a runtime slot, so a clear message replaces a deep app-server spawn failure.
 */
export async function codexLoginMissingError(): Promise<string | null> {
  if ((await detectCodexAccount()).available) return null;
  log.error('[Socket Executor] Codex is not authenticated on this machine');
  return 'Codex isn’t authenticated on this machine. Run `codex login` (or use this project on a machine where Codex is signed in).';
}
