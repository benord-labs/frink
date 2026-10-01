/**
 * Skill projection — copy a skill dir into the three universal, machine-local
 * targets so it "follows" the user across the big-5 coding tools. REAL COPIES, not
 * symlinks: symlinks dangle on uninstall and pollute committed repos (ruling in the
 * provider-config-canonical-home decision, docs/decisions/).
 *
 * Shared by the boot provisioner (frink-shipped skills) and the spawn-time handler
 * (`handlers/skills.ts`, user skills). Mutex-serialized + idempotent so concurrent
 * panes / boot never leave a half-state. Provenance-marked (`.frink-projected`) so
 * re-projection never re-sources or clobbers a user-authored dir and preserves any
 * user edit to a projected copy.
 */

import { existsSync, lstatSync } from 'node:fs';
import { cp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Mutex } from 'async-mutex';
import log from 'electron-log';
import { getUniversalSkillDirs } from '../frink-skills-dir';
import { ensureDirExistsAsync } from '../fs-helpers';
import { dirHash, dirStatSig, replaceDir } from './skill-fs';

/**
 * Marker file written INSIDE a projected skill dir, recording at projection time:
 *  - `hash`   — content hash of the projected copy (the authoritative change signal),
 *  - `sig`    — cheap stat-signature (mtime+size) of the copy, and
 *  - `srcSig` — stat-signature of the SOURCE.
 * The two sigs let reconcile skip the expensive content re-hash when nothing changed.
 */
export const PROVENANCE_MARKER = '.frink-projected';
/** Frink-shipped marker (written by the boot provisioner into the canonical store). */
const BASELINE_MARKER = '.baseline.json';
const EXCLUDE_FROM_HASH: ReadonlySet<string> = new Set([PROVENANCE_MARKER]);
const projectionMutex = new Mutex();
/** Crash-debris names: `<name>.staging-<pid>-<ts>` (copyInto) and `<name>.old-<ts>` (replaceDir). */
export const ORPHAN_NAME = /\.(?:staging-\d+-\d+|old-\d+)$/;

/** The three machine-local universal skill targets (single definition in frink-skills-dir). */
const getSkillTargetDirs = getUniversalSkillDirs;

/** A projected dir is one we wrote (carries the provenance marker). */
export function isFrinkProjection(dir: string): boolean {
  return existsSync(join(dir, PROVENANCE_MARKER));
}

/** A frink-shipped first-party skill (carries the baseline marker; the provisioner owns it). */
export function isFrinkShipped(dir: string): boolean {
  return existsSync(join(dir, BASELINE_MARKER));
}

type Provenance = { hash: string; sig?: string; srcSig?: string };

async function readProvenance(dir: string): Promise<Provenance | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dir, PROVENANCE_MARKER), 'utf8'),
    ) as Partial<Provenance>;
    return typeof parsed.hash === 'string'
      ? { hash: parsed.hash, sig: parsed.sig, srcSig: parsed.srcSig }
      : null;
  } catch {
    return null;
  }
}

async function copyInto(sourceDir: string, target: string): Promise<void> {
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  await cp(sourceDir, staging, { recursive: true });
  await replaceDir(staging, target);
  // The marker excludes itself, so writing it doesn't change the recorded signatures.
  const hash = await dirHash(target, EXCLUDE_FROM_HASH);
  const sig = await dirStatSig(target, EXCLUDE_FROM_HASH);
  const srcSig = await dirStatSig(sourceDir, EXCLUDE_FROM_HASH);
  const marker: Provenance = { hash, sig, srcSig };
  await writeFile(join(target, PROVENANCE_MARKER), JSON.stringify(marker), 'utf8');
}

/**
 * Remove crash-orphaned staging/backup dirs (`*.staging-*` / `*.old-*`) left in a
 * target base by a killed projection. Safe to run unconditionally: projections are
 * mutex-serialized AND Frink is single-instance, so no staging is ever in-flight here.
 */
async function sweepOrphans(baseDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(baseDir);
  } catch {
    return;
  }
  for (const name of names) {
    // Anchor to the EXACT debris grammar `copyInto`/`replaceDir` produce —
    // `<name>.staging-<pid>-<ts>` and `<name>.old-<ts>` (all-numeric runs at end of
    // name) — so a real user skill like `my-prompt.old-draft` is never matched/removed.
    if (ORPHAN_NAME.test(name)) {
      await rm(join(baseDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** lstat that does NOT follow the link (a DANGLING symlink is still seen) — null on ENOENT. */
function lstatOrNull(target: string): import('node:fs').Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * Decide what to do with an EXISTING frink projection at `target`.
 * Fast path: stat signatures unchanged on BOTH sides → 'unchanged' with zero content
 * reads. The fast path may ONLY ever elect a no-op — it never overwrites, so a
 * stat-missed edit (touch -r) stays preserved. The content hash is the SOLE authority
 * for preserve-vs-overwrite; old `{hash}`-only markers (no sig) land there directly.
 */
async function reconcileProjection(
  sourceDir: string,
  target: string,
): Promise<'unchanged' | 'edited-by-user' | 'overwrite'> {
  const stored = await readProvenance(target);
  if (!stored) return 'overwrite'; // unreadable/corrupt marker → re-project
  if (
    stored.sig &&
    stored.srcSig &&
    (await dirStatSig(target, EXCLUDE_FROM_HASH)) === stored.sig &&
    (await dirStatSig(sourceDir, EXCLUDE_FROM_HASH)) === stored.srcSig
  ) {
    return 'unchanged';
  }
  if ((await dirHash(target, EXCLUDE_FROM_HASH)) !== stored.hash) return 'edited-by-user';
  if ((await dirHash(sourceDir, EXCLUDE_FROM_HASH)) === stored.hash) return 'unchanged';
  return 'overwrite'; // source changed under a clean projection
}

async function projectToTarget(
  sourceDir: string,
  baseDir: string,
  skillName: string,
): Promise<void> {
  await ensureDirExistsAsync(baseDir);
  const target = join(baseDir, skillName);

  const lst = lstatOrNull(target);
  if (lst?.isSymbolicLink()) {
    // Existing symlink (incl. a dangling one) → migrate to a real copy.
    await unlink(target).catch(() => {});
  } else if (lst && !isFrinkProjection(target)) {
    // User-authored real dir — never clobber.
    log.info(`[skill-projection] ${skillName}: non-frink skill dir at ${target}; skipping`);
    return;
  } else if (lst) {
    const verdict = await reconcileProjection(sourceDir, target);
    if (verdict === 'unchanged') return;
    if (verdict === 'edited-by-user') {
      log.warn(
        `[skill-projection] ${skillName}: projected copy at ${target} edited by user; preserving`,
      );
      return;
    }
  }
  await sweepOrphans(baseDir); // clear crash debris before we stage a new copy
  await copyInto(sourceDir, target);
}

/**
 * Project one skill dir (REAL COPY) into all three universal targets. Mutex-serialized,
 * idempotent, best-effort per target (a single target failure is logged, not thrown).
 */
export async function projectSkill(skillName: string, sourceDir: string): Promise<void> {
  await projectionMutex.runExclusive(async () => {
    for (const baseDir of getSkillTargetDirs()) {
      try {
        await projectToTarget(sourceDir, baseDir, skillName);
      } catch (err) {
        log.warn(`[skill-projection] ${skillName} → ${baseDir} failed: ${(err as Error).message}`);
      }
    }
  });
}

/**
 * USER-initiated copy of a skill into each of `targetSkillsDirs` (absolute `<base>/<tooldir>/skills`
 * paths the caller chose by breadth — see `skillCopyDirs`). Unlike `projectSkill`, it writes NO
 * `.frink-projected` marker — the result is a plain, user-OWNED skill that stays visible in the scan and
 * is never orphan-swept (the user's deliberate copy, not a Frink projection). Skips a target that IS the
 * source, and NEVER clobbers a target whose content differs from the source (a hand-edited copy).
 * Returns per-dir counts so the caller can report truthfully: `wrote` dirs gained a copy, `kept` dirs
 * held a divergent hand-edit that was preserved.
 */
export async function copyUserSkill(
  skillName: string,
  sourceDir: string,
  targetSkillsDirs: string[],
): Promise<{ wrote: number; kept: number }> {
  if (skillName.includes('..') || skillName.includes('/') || skillName.includes('\\')) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }
  // A vanished source must fail loudly: `dirHash` swallows ENOENT (hashes to empty), which would
  // otherwise be mistaken for a divergent target and reported as "kept your edited copy".
  if (!existsSync(sourceDir)) throw new Error(`Skill source missing: ${sourceDir}`);
  let wrote = 0;
  let kept = 0;
  await projectionMutex.runExclusive(async () => {
    const srcHash = await dirHash(sourceDir, EXCLUDE_FROM_HASH);
    for (const targetBase of targetSkillsDirs) {
      const target = join(targetBase, skillName);
      if (target === sourceDir) continue; // copying onto itself
      if (existsSync(target)) {
        // Present already — preserve a hand-edited copy (never clobber); identical copies are a no-op.
        if ((await dirHash(target, EXCLUDE_FROM_HASH)) !== srcHash) kept++;
        continue;
      }
      await ensureDirExistsAsync(targetBase);
      await cp(sourceDir, target, { recursive: true });
      wrote++;
    }
  });
  return { wrote, kept };
}
