import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import type { AgentRuntime } from '../../../shared/lib/ai-providers';
import { captureMainMessage } from '../sentry/init';

/** One session's setup by category. A category the provider did not report is left out. */
export type LoadSet = {
  agents?: string[];
  mcpServers?: string[];
  plugins?: string[];
  skills?: string[];
};

export const STAGED_VS_LOADED_SURFACE = 'provider-staged-vs-loaded';
const CATEGORIES = ['agents', 'mcpServers', 'plugins', 'skills'] as const;
type Category = (typeof CATEGORIES)[number];
const MAX_NAMES = 10;
/** The mismatches this app run has already sent. */
const reported = new Set<string>();

/** Per reported category, the staged names the provider left out, sorted. */
function missingNames(staged: LoadSet, loaded: LoadSet): [Category, string[]][] {
  return CATEGORIES.flatMap((category): [Category, string[]][] => {
    const listed = loaded[category];
    if (!listed) return [];
    const missing = (staged[category] ?? []).filter((name) => !listed.includes(name)).sort();
    return missing.length > 0 ? [[category, missing]] : [];
  });
}

function describeMissing([category, names]: [Category, string[]]): string {
  const more = names.length - MAX_NAMES;
  return `${category}: ${names.slice(0, MAX_NAMES).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** Reports what a provider did not load: names only, never paths or file contents. */
export function reportStagedNotLoaded(
  runtime: AgentRuntime,
  subChatId: string,
  staged: LoadSet,
  loaded: LoadSet,
): void {
  const missing = missingNames(staged, loaded);
  if (missing.length === 0) return;
  const message = `${runtime} loaded less than Frink staged (${missing.map(describeMissing).join('; ')})`;
  log.warn(`[provider] ${message}`);
  if (reported.has(message)) return;
  reported.add(message);
  const categories = missing.map(([category]) => category);
  captureMainMessage(
    message,
    'warning',
    { surface: STAGED_VS_LOADED_SURFACE, runtime, subChatId, categories: categories.join(',') },
    [STAGED_VS_LOADED_SURFACE, runtime, ...categories],
  );
}

/** Folders under a skills root that hold a SKILL.md, following links. A missing root has none. */
export async function skillFolders(root: string): Promise<string[]> {
  const names = await fs.promises.readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const held = await Promise.all(
    names.map((name) =>
      fs.promises.stat(path.join(root, name, 'SKILL.md')).then(
        (stat) => stat.isFile(),
        () => false,
      ),
    ),
  );
  return names.filter((_, index) => held[index]);
}

/** Test-only: forget which mismatches this app run already sent. */
export function __resetStagedVsLoadedForTest(): void {
  reported.clear();
}
