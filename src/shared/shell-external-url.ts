/**
 * Allowed URL schemes for shell.openExternal from renderer IPC and shared callers.
 * Blocks javascript:, file:, custom handlers, etc.
 */
/** Outcome of a guarded system-browser launch, as it crosses main → preload → renderer. */
export type ShellOpenExternalResult =
  | { success: true }
  | { success: false; error: 'blocked_url' | 'open_failed' };

export function isAllowedShellOpenExternalUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    const protocol = u.protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}
