import { join } from 'node:path';
import log from 'electron-log';

/** Configure the main log before any `log.*` call; `FRINK_LOG_DIR` relocates it per run (sc-2903). */
export function configureMainLog(): void {
  log.transports.file.sync = false;
  log.transports.file.maxSize = 20 * 1024 * 1024;
  const dir = process.env.FRINK_LOG_DIR;
  if (dir) log.transports.file.resolvePathFn = () => mainLogPath(dir);
}

/** Where a relocated main log lands. An unwritable dir is SILENT — assert content, not this path. */
export function mainLogPath(dir: string): string {
  return join(dir, 'main.log');
}

/** Resolve the actual log location for startup error dialogs, even when logging is unavailable. */
export function getMainLogPath(): string {
  try {
    const path = log.transports.file.getFile().path;
    return typeof path === 'string' && path.length > 0 ? path : 'unknown';
  } catch {
    return 'unknown';
  }
}
