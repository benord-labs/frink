/**
 * Shared filesystem helpers.
 *
 * Generic directory/file utilities used by agents, MCP, and other config modules.
 */

import { existsSync, mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';

/**
 * Ensure a directory exists, creating it recursively if needed (sync).
 */
export function ensureDirExists(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed (async).
 */
export async function ensureDirExistsAsync(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

/** True when `file` is a regular file this process may use with `mode` (`constants.R_OK`, `X_OK`…). */
export async function isFileWith(file: string, mode: number): Promise<boolean> {
  try {
    await fs.access(file, mode);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
