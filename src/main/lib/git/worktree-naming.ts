import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { adjectives, uniqueNamesGenerator } from 'unique-names-generator';
import { landscapes } from './dictionaries/landscapes';

const MAX_RETRIES = 10;

function generateLandscapeName(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, landscapes],
    separator: '-',
    length: 2,
    style: 'lowerCase',
  });
}

/**
 * Sanitize project name for filesystem-safe directory usage.
 * Strips dots to prevent path traversal (e.g. '..').
 */
export function sanitizeProjectName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  return sanitized || 'project';
}

/**
 * Generate a unique folder name for a worktree under a project directory.
 */
export function generateWorktreeFolderName(parentDir: string): string {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const name = generateLandscapeName();
    if (!existsSync(join(parentDir, name))) {
      return name;
    }
  }

  const baseName = generateLandscapeName();
  for (let suffix = 2; suffix <= 999; suffix++) {
    const candidate = `${baseName}-${suffix}`;
    if (!existsSync(join(parentDir, candidate))) {
      return candidate;
    }
  }

  return `${baseName}-${Date.now().toString(36)}`;
}
