import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

const VERSION_DIR_REGEX = /^v(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a: string, b: string): number {
  const pa = VERSION_DIR_REGEX.exec(a);
  const pb = VERSION_DIR_REGEX.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function listInstalledVersions(versionsDir: string): Promise<string[]> {
  const names = await readdir(versionsDir).catch(() => []);
  return names.filter((name) => VERSION_DIR_REGEX.test(name)).sort(compareVersions);
}

async function readAlias(nvmDir: string, name: string): Promise<string | null> {
  const text = await readFile(path.join(nvmDir, 'alias', name), 'utf8').catch(() => '');
  return text.trim() || null;
}

/** The installed version nvm's `default` alias points at, or null when it names none. */
async function resolveDefaultVersion(nvmDir: string, installed: string[]): Promise<string | null> {
  // An alias may name another alias (default -> lts/* -> lts/jod -> v22.20.0), to any depth;
  // stop at the first name with no alias file, or at a cycle.
  const seen = new Set<string>();
  let target = await readAlias(nvmDir, 'default');
  while (target && !seen.has(target)) {
    seen.add(target);
    const next = await readAlias(nvmDir, target);
    if (!next) break;
    target = next;
  }
  if (!target) return null;

  const wanted = target.startsWith('v') ? target : `v${target}`;
  const matches = installed.filter((v) => v === wanted || v.startsWith(`${wanted}.`));
  return matches.at(-1) ?? null;
}

const resolvedByHome = new Map<string, string[]>();

/** Read nvm's active bin dir for `home` off the request path; `cachedNvmBinDirs` then serves it. */
export async function warmNvmBinDirs(home: string): Promise<string[]> {
  const nvmDir = path.join(home, '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  const installed = await listInstalledVersions(versionsDir);
  const version = (await resolveDefaultVersion(nvmDir, installed)) ?? installed.at(-1);
  const dirs = version ? [path.join(versionsDir, version, 'bin')] : [];
  resolvedByHome.set(home, dirs);
  return [...dirs];
}

/** The bin dir nvm would activate — its `default` alias, else the newest install — once warmed.
 * Never touches the disk: PATH config is built on request paths. */
export function cachedNvmBinDirs(home: string): string[] {
  return [...(resolvedByHome.get(home) ?? [])];
}
