import { shell } from 'electron';
import {
  isAllowedShellOpenExternalUrl,
  type ShellOpenExternalResult,
} from '../../shared/shell-external-url';

/** Open in the system browser only for http(s)/mailto — shared by IPC, tRPC, and tests. */
export async function shellOpenExternalGuarded(url: string): Promise<ShellOpenExternalResult> {
  const trimmed = url.trim();
  if (!isAllowedShellOpenExternalUrl(trimmed)) {
    return { success: false, error: 'blocked_url' };
  }
  try {
    await shell.openExternal(trimmed);
    return { success: true };
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: surface OS/browser open failures in main process logs
    console.warn('[shellOpenExternalGuarded] shell.openExternal failed:', err);
    return { success: false, error: 'open_failed' };
  }
}
