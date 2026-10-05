/**
 * Boot-time provisioner for Frink-managed skills.
 *
 * Frink ships skill assets (currently `frink-flows`) bundled inside the
 * application. On boot we make those skills available to:
 *
 *   1. The Claude Agent SDK (it scans `~/.claude/skills/`).
 *   2. Cursor (it scans `~/.cursor/skills/`).
 *   3. Frink's own settings UI (it scans `~/.frink/skills/`).
 *
 * Source of truth is `~/.frink/skills/<name>/`. The per-tool paths above hold
 * REAL COPIES projected from it (not symlinks — symlinks dangle on uninstall
 * and pollute committed repos; ruling in the provider-config-canonical-home
 * decision, docs/decisions/). The projection itself lives in `skill-projection`.
 *
 * Updates merge per file against `.baseline.json`: edited files are kept, the rest take the
 * shipped version (policy: frink-flows-skill-source-of-truth decision).
 *
 * Because the per-tool copies are now independent of the canonical store, an
 * edit to a projected copy diverges from `~/.frink/skills` (a symlink edit used
 * to write through to it). A shipped update then keeps the edited files of that
 * copy and updates the rest of it (see `skill-projection` reconcile). The copy
 * path also needs no Windows symlink/Developer-Mode permission, removing a prior
 * silent "skipped" failure mode.
 *
 * NOTE: provisioning runs once at app boot, before any agent is spawned —
 * there is no concurrency to worry about.
 */

import { existsSync } from 'node:fs';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import log from 'electron-log';
import { canonicalStringify } from '../../../shared/lib/canonical-stringify';
import { getFrinkSkillsDir } from '../frink-skills-dir';
import { ensureDirExistsAsync } from '../fs-helpers';
import { resolveElectronResourcePath } from '../platform/electron-resource-path';
import { captureContained } from '../sentry';
import { copyFiles, replaceDir, sha256 } from './skill-fs';
import { projectSkill } from './skill-projection';

const SKILLS_TO_PROVISION: readonly string[] = ['frink-flows'];

type BaselineFile = { sha256: string; bytes: number };
type Baseline = {
  generatedAt: string;
  version: string;
  files: Record<string, BaselineFile>;
};

export type ProvisionOutcome = {
  skill: string;
  status: 'installed' | 'updated' | 'unchanged' | 'preserved-user-edits' | 'no-source' | 'failed';
  details?: string;
};

function resolveSourceRoot(): string {
  // Importing electron at module top-level breaks unit tests; resolve lazily.
  const electron = tryRequireElectron();
  if (!electron) {
    // Test / non-electron context: assume cwd is repo root.
    return resolve(process.cwd(), 'assets', 'skills');
  }
  return resolveElectronResourcePath(electron.app, {
    development: ['assets', 'skills'],
    packaged: ['assets', 'skills'],
  });
}

function tryRequireElectron(): typeof import('electron') | null {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

/**
 * Compare two baseline manifests for "logical equality" — version + the
 * `files` map (sorted keys, all fields). `generatedAt` is excluded because it
 * is derived from `version`. Uses `canonicalStringify` so any future fields
 * added to `BaselineFile` (e.g. `mtime`, `chmod`) are picked up without code
 * changes here.
 */
function baselinesEqual(a: Baseline, b: Baseline): boolean {
  return (
    canonicalStringify({ version: a.version, files: a.files }) ===
    canonicalStringify({ version: b.version, files: b.files })
  );
}

async function readBaseline(dir: string): Promise<Baseline | null> {
  try {
    const raw = await readFile(join(dir, '.baseline.json'), 'utf8');
    return JSON.parse(raw) as Baseline;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Files in `dir` edited relative to `baseline`; missing files and content equal to the
 *  `shipped` entry are not edits. */
async function diffAgainstBaseline(
  dir: string,
  baseline: Baseline,
  shipped?: Baseline,
): Promise<string[]> {
  const drift: string[] = [];
  for (const [relPath, expected] of Object.entries(baseline.files)) {
    let content: Buffer;
    try {
      content = await readFile(join(dir, relPath));
    } catch {
      continue;
    }
    const hash = sha256(content);
    if (content.length === expected.bytes && hash === expected.sha256) continue;
    if (hash === shipped?.files[relPath]?.sha256) continue;
    drift.push(relPath);
  }
  return drift;
}

/** Remove `<name>-*-rejected` dirs left by the retired whole-skill rejection policy. */
async function removeRejectedDrops(skillName: string): Promise<void> {
  const skillsDir = getFrinkSkillsDir();
  const entries = await readdir(skillsDir);
  const rejected = entries.filter((e) => e.startsWith(`${skillName}-`) && e.endsWith('-rejected'));
  for (const name of rejected) {
    await rm(join(skillsDir, name), { recursive: true, force: true });
  }
}

/** True when every non-preserved file is already at its shipped version — nothing to write. */
function onlyPreservedDiffer(user: Baseline, shipped: Baseline, preserved: string[]): boolean {
  if (user.version !== shipped.version) return false;
  const keep = new Set(preserved);
  const paths = new Set([...Object.keys(user.files), ...Object.keys(shipped.files)]);
  return [...paths].every(
    (p) =>
      keep.has(p) || canonicalStringify(user.files[p]) === canonicalStringify(shipped.files[p]),
  );
}

/** Files in `dest` that no baseline tracks — user-authored additions the merge must carry over. */
async function untrackedFiles(dest: string, tracked: ReadonlySet<string>): Promise<string[]> {
  const entries = await readdir(dest, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dest, join(e.parentPath, e.name)).split('\\').join('/'))
    .filter((rel) => rel !== '.baseline.json' && !tracked.has(rel));
}

/**
 * Restore shipped files absent from `dest`. Deleting a file is how a user takes the shipped
 * version of one they edited, so it must work even when the manifests otherwise agree.
 */
async function restoreMissingFiles(
  src: string,
  dest: string,
  shipped: Baseline,
): Promise<string[]> {
  const missing = Object.keys(shipped.files).filter((rel) => !existsSync(join(dest, rel)));
  await copyFiles(src, dest, missing);
  return missing;
}

/**
 * Stage the shipped copy, overlay the kept edits (each keeping its old baseline entry)
 * and any user-added files, then swap it over the live copy atomically and re-project.
 */
async function mergeIntoLive(
  skillName: string,
  src: string,
  dest: string,
  shipped: Baseline,
  user: Baseline,
  preserved: string[],
): Promise<void> {
  const staging = join(
    getFrinkSkillsDir(),
    `.staging-${skillName}-${shipped.version}-${process.pid}`,
  );
  await rm(staging, { recursive: true, force: true });
  await cp(src, staging, { recursive: true });
  const merged: Baseline = { ...shipped, files: { ...shipped.files } };
  await copyFiles(dest, staging, preserved);
  for (const relPath of preserved) merged.files[relPath] = user.files[relPath];
  const tracked = new Set([...Object.keys(shipped.files), ...Object.keys(user.files)]);
  await copyFiles(dest, staging, await untrackedFiles(dest, tracked));
  await writeFile(join(staging, '.baseline.json'), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await replaceDir(staging, dest);
  await projectSkill(skillName, dest);
}

async function provisionOne(skillName: string, sourceRoot: string): Promise<ProvisionOutcome> {
  const src = join(sourceRoot, skillName);
  const dest = join(getFrinkSkillsDir(), skillName);

  if (!existsSync(src)) {
    return { skill: skillName, status: 'no-source', details: `source dir not found: ${src}` };
  }

  const shippedBaseline = await readBaseline(src);
  if (!shippedBaseline) {
    return {
      skill: skillName,
      status: 'failed',
      details: `shipped .baseline.json missing in ${src}`,
    };
  }

  await ensureDirExistsAsync(getFrinkSkillsDir());
  await removeRejectedDrops(skillName);

  // Fresh install — dest doesn't exist yet.
  if (!existsSync(dest)) {
    await cp(src, dest, { recursive: true });
    await projectSkill(skillName, dest);
    return { skill: skillName, status: 'installed', details: `version ${shippedBaseline.version}` };
  }

  const userBaseline = await readBaseline(dest);
  // No baseline recorded in the user copy: foreign content we cannot diff — never overwrite.
  if (!userBaseline) {
    log.warn(
      `[skill-provisioner] "${skillName}" at ${dest} has no .baseline.json; not updating it. Delete the directory and restart Frink to reinstall.`,
    );
    return {
      skill: skillName,
      status: 'preserved-user-edits',
      details: 'no .baseline.json in user dir; refusing to overwrite',
    };
  }

  // Already up to date? Compare baseline manifests directly — version string
  // alone is too coarse, because content can legitimately change inside a
  // single package version during a feature branch's lifetime and the
  // provisioner must still swap when the shipped file set or hashes differ.
  const restored = await restoreMissingFiles(src, dest, shippedBaseline);
  if (baselinesEqual(userBaseline, shippedBaseline)) {
    await projectSkill(skillName, dest);
    return {
      skill: skillName,
      status: restored.length > 0 ? 'updated' : 'unchanged',
      details: `version ${shippedBaseline.version}${restored.length > 0 ? `; restored ${restored.join(', ')}` : ''}`,
    };
  }

  return applyUpdate(skillName, src, dest, shippedBaseline, userBaseline);
}

/** Manifest differs from shipped: keep edited files, update the rest. Silent no-op when
 *  only kept edits differ, so each shipped change warns once. */
async function applyUpdate(
  skillName: string,
  src: string,
  dest: string,
  shipped: Baseline,
  user: Baseline,
): Promise<ProvisionOutcome> {
  const preserved = await diffAgainstBaseline(dest, user, shipped);
  if (preserved.length === 0) {
    await mergeIntoLive(skillName, src, dest, shipped, user, preserved);
    const manifestOnly = user.version === shipped.version;
    return {
      skill: skillName,
      status: 'updated',
      details: manifestOnly
        ? `version ${shipped.version} (manifest refresh)`
        : `${user.version} → ${shipped.version}`,
    };
  }

  const details = `kept ${preserved.length} locally edited file(s): ${preserved.join(', ')}`;
  if (onlyPreservedDiffer(user, shipped, preserved)) {
    await projectSkill(skillName, dest);
    return { skill: skillName, status: 'preserved-user-edits', details };
  }

  await mergeIntoLive(skillName, src, dest, shipped, user, preserved);
  const routerNote = preserved.includes('SKILL.md')
    ? ' SKILL.md is among them, so it may now contradict the updated references.'
    : '';
  log.warn(
    `[skill-provisioner] updated "${skillName}" but ${details}.${routerNote} Delete a file and restart Frink to take the shipped version.`,
  );
  return { skill: skillName, status: 'preserved-user-edits', details };
}

/**
 * Public entry — provision every shipped skill. Failures on individual skills
 * do NOT abort boot; they are logged and reported in the returned outcomes.
 */
export async function provisionFrinkSkills(): Promise<ProvisionOutcome[]> {
  const sourceRoot = resolveSourceRoot();
  const outcomes: ProvisionOutcome[] = [];
  for (const skill of SKILLS_TO_PROVISION) {
    try {
      outcomes.push(await provisionOne(skill, sourceRoot));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[skill-provisioner] failed to provision ${skill}: ${message}`);
      // Contained: boot continues, but every agent then reads a stale or absent skill.
      captureContained(err, { surface: 'skill-provisioner', skill });
      outcomes.push({ skill, status: 'failed', details: message });
    }
  }
  for (const outcome of outcomes) {
    log.info(
      `[skill-provisioner] ${outcome.skill}: ${outcome.status}${outcome.details ? ` — ${outcome.details}` : ''}`,
    );
  }
  return outcomes;
}

// Exported for unit tests.
export const __test__ = {
  getFrinkSkillsDir,
  baselinesEqual,
  diffAgainstBaseline,
  provisionOne,
  replaceDir,
  resolveSourceRoot,
  sha256,
};
