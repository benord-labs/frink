/**
 * Resolve a native CLI binary that Frink BUNDLES in its app resources.
 *
 * Both the Claude and Codex CLIs ship inside the app (downloaded at build time into
 * `resources/bin/`), so "install the Frink app" is all a user needs — no `npm i -g`.
 * DEV reads the repo's `resources/bin/{platform}-{arch}/`; a packaged app reads
 * `{resourcesPath}/bin/` (only the host platform's binary is packaged, placed flat).
 */

import path from 'node:path';
import { app } from 'electron';
import { isWindows } from '../platform';

/**
 * Absolute path to the bundled binary named `baseName` (`.exe` appended on Windows).
 * Does NOT check existence — the caller decides what to do when it's absent (e.g.
 * fall back to a user-installed binary on PATH).
 */
export function getBundledBinaryPath(baseName: string): string {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources/bin', `${process.platform}-${process.arch}`);
  return path.join(dir, isWindows() ? `${baseName}.exe` : baseName);
}
