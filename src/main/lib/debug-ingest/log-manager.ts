/**
 * Debug log paths and directory setup for NDJSON files under .frink/debug/.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEBUG_DIR_NAME = '.frink/debug';

export function getDebugLogPath(projectPath: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(projectPath, DEBUG_DIR_NAME, `${safeSessionId}.ndjson`);
}

export function ensureDebugLogDir(projectPath: string): void {
  const dir = path.join(projectPath, DEBUG_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
}
