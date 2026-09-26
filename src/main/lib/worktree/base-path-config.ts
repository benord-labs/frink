import { readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureDirExistsAsync } from '../fs-helpers';
import {
  isSafeConfiguredWorktreeBasePath,
  normalizeWorktreeBasePath,
} from './base-path-validation';
import { frinkUserHome } from '../platform/frink-home';

export const DEFAULT_WORKTREE_BASE_PATH = path.join(frinkUserHome(), '.frink', 'worktrees');
const FRINK_WORKTREE_CONFIG_DIR = path.join(frinkUserHome(), '.frink', 'worktrees');
export const FRINK_WORKTREE_CONFIG_PATH = path.join(FRINK_WORKTREE_CONFIG_DIR, 'config.json');
export const WORKTREE_CONFIG_VERSION = 1;

type FrinkWorktreeConfig = {
  version: number;
  worktreeBasePath?: string;
};

const DEFAULT_CONFIG: FrinkWorktreeConfig = {
  version: WORKTREE_CONFIG_VERSION,
};

function migrateConfig(config: FrinkWorktreeConfig): FrinkWorktreeConfig {
  return {
    ...config,
    version: WORKTREE_CONFIG_VERSION,
  };
}

async function readWorktreeBaseConfig(): Promise<FrinkWorktreeConfig> {
  let parsed: FrinkWorktreeConfig;
  try {
    const content = await fs.readFile(FRINK_WORKTREE_CONFIG_PATH, 'utf-8');
    parsed = JSON.parse(content) as FrinkWorktreeConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  if (parsed.version !== WORKTREE_CONFIG_VERSION) {
    const migrated = migrateConfig(parsed);
    try {
      await fs.writeFile(FRINK_WORKTREE_CONFIG_PATH, JSON.stringify(migrated, null, 2), 'utf-8');
    } catch {
      // Best-effort migration persist. Continue using migrated config in-memory.
    }
    return migrated;
  }

  return parsed;
}

function readWorktreeBaseConfigSync(): FrinkWorktreeConfig {
  try {
    const content = readFileSync(FRINK_WORKTREE_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(content) as FrinkWorktreeConfig;
    if (parsed.version !== WORKTREE_CONFIG_VERSION) {
      const migrated = migrateConfig(parsed);
      try {
        writeFileSync(FRINK_WORKTREE_CONFIG_PATH, JSON.stringify(migrated, null, 2), 'utf-8');
      } catch {
        // Best-effort migration persist. Continue using migrated config in-memory.
      }
      return migrated;
    }
    return parsed;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeWorktreeBaseConfig(config: FrinkWorktreeConfig): Promise<void> {
  await ensureDirExistsAsync(FRINK_WORKTREE_CONFIG_DIR);
  await fs.writeFile(FRINK_WORKTREE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

async function getConfiguredWorktreeBasePath(): Promise<string | null> {
  const config = await readWorktreeBaseConfig();
  if (!config.worktreeBasePath) {
    return null;
  }
  if (!isSafeConfiguredWorktreeBasePath(config.worktreeBasePath)) {
    // biome-ignore lint/suspicious/noConsole: warn and safely ignore malformed manual config edits
    console.warn('[worktree-base-config] Ignoring invalid configured worktree base path');
    return null;
  }
  return normalizeWorktreeBasePath(config.worktreeBasePath);
}

function getConfiguredWorktreeBasePathSync(): string | null {
  const config = readWorktreeBaseConfigSync();
  if (!config.worktreeBasePath) {
    return null;
  }
  if (!isSafeConfiguredWorktreeBasePath(config.worktreeBasePath)) {
    // biome-ignore lint/suspicious/noConsole: warn and safely ignore malformed manual config edits
    console.warn('[worktree-base-config] Ignoring invalid configured worktree base path');
    return null;
  }
  return normalizeWorktreeBasePath(config.worktreeBasePath);
}

export async function resolveWorktreeBasePath(): Promise<string> {
  const configuredPath = await getConfiguredWorktreeBasePath();
  return configuredPath ?? DEFAULT_WORKTREE_BASE_PATH;
}

export function resolveWorktreeBasePathSync(): string {
  const configuredPath = getConfiguredWorktreeBasePathSync();
  return configuredPath ?? DEFAULT_WORKTREE_BASE_PATH;
}

export async function setWorktreeBasePath(basePath: string): Promise<string> {
  const normalized = normalizeWorktreeBasePath(basePath);
  const config = await readWorktreeBaseConfig();
  await writeWorktreeBaseConfig({
    ...config,
    version: WORKTREE_CONFIG_VERSION,
    worktreeBasePath: normalized,
  });
  return normalized;
}

export async function resetWorktreeBasePath(): Promise<void> {
  const config = await readWorktreeBaseConfig();
  delete config.worktreeBasePath;
  await writeWorktreeBaseConfig({
    ...config,
    version: WORKTREE_CONFIG_VERSION,
  });
}
