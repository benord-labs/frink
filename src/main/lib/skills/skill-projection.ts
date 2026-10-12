/**
 * Skill projection — copy a skill dir into the three universal, machine-local
 * targets so it "follows" the user across the big-5 coding tools. REAL COPIES, not
 * symlinks: symlinks dangle on uninstall and pollute committed repos (ruling in the
 * provider-config-canonical-home decision, docs/decisions/).
 *
 * Shared by the boot provisioner (frink-shipped skills) and the spawn-time handler
 * (`handlers/skills.ts`, user skills). Mutex-serialized + idempotent so concurrent
 * panes / boot never leave a half-state. Provenance-marked (`.frink-projected`) so
 * re-projection never re-sources or clobbers a user-authored dir and keeps the files
 * a user edited in a projected copy, while the rest of that copy follows the source.
 */

import { existsSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Mutex } from 'async-mutex';
import log from 'electron-log';
import { z } from 'zod';
import { getUniversalSkillDirs } from '../frink-skills-dir';
import { ensureDirExistsAsync } from '../fs-helpers';
import {
  dropFile,
  linkExpectation,
  lstatOrNull,
  moveAside,
  putBack,
  replaceFile,
  replaceFolder,
  throughLink,
} from './skill-guarded-write';
import {
  clashesWithKept,
  leftoverLinks,
  splitLeftovers,
  withKeptEntries,
} from './skill-projection-compare';
import { copyFiles, dirHash, dirHashOf, dirStatSig, readTree, replaceDir } from './skill-fs';

/**
 * Marker file written INSIDE a projected skill dir, recording at projection time:
 *  - `files`  — hash of the source version each file was last taken at (a kept edit keeps
 *               its OLD entry, or none), the authoritative edit signal,
 *  - `hash`   — content hash of the SOURCE, so a build predating `files` sees kept edits
 *               as an edited copy and leaves it alone,
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

type FileHashes = Record<string, string>;

/** `files` that is not a map of hashes reads as absent, like a marker written before it existed. */
const SHA256 = /^[0-9a-f]{64}$/;
const provenanceSchema = z.object({
  // A marker whose hash is not a real hash is as unreadable as no marker at all.
  hash: z.string().regex(SHA256),
  sig: z.string().optional().catch(undefined),
  srcSig: z.string().optional().catch(undefined),
  files: z.record(z.string(), z.string().regex(SHA256)).optional().catch(undefined),
  /** Empty folders the source had, so one it later removes can be removed here too. */
  folders: z.array(z.string()).optional().catch(undefined),
});
type Provenance = z.infer<typeof provenanceSchema>;

async function readProvenance(dir: string): Promise<Provenance | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, PROVENANCE_MARKER), 'utf8'));
    return provenanceSchema.safeParse(raw).data ?? null;
  } catch {
    return null;
  }
}

/** Write the marker atomically: a torn marker would read as missing and re-project everything.
 *  The temp file sits beside the copy under the crash-debris name, so a sweep removes it. */
async function writeProvenance(copyDir: string, marker: Provenance): Promise<void> {
  const temp = `${copyDir}.staging-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(marker), 'utf8');
  await rename(temp, join(copyDir, PROVENANCE_MARKER));
}

/** Stage a fresh copy, marker included, and swap it in. `srcSig` predates the copy and the
 *  baseline is hashed from the staged files, so a mid-copy source change is not recorded. */
async function copyInto(sourceDir: string, target: string, srcSig: string): Promise<void> {
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  const source = await readTree(sourceDir, EXCLUDE_FROM_HASH, true);
  if (source.unreadable.length > 0) throw unreadableSource(source.unreadable);
  await ensureDirExistsAsync(staging);
  await copyFiles(sourceDir, staging, Object.keys(source.files), { dereference: true });
  for (const rel of source.empty) await mkdir(join(staging, rel), { recursive: true });
  const { files } = await readTree(staging, EXCLUDE_FROM_HASH);
  // The marker is excluded from the signature, so writing it doesn't change it.
  const sig = await dirStatSig(staging, EXCLUDE_FROM_HASH);
  const folders = source.empty;
  await writeProvenance(staging, { hash: dirHashOf(files), sig, srcSig, files, folders });
  // An old symlink install is moved aside, not removed, so a failed swap can put it back.
  const oldLink = (await lstatOrNull(target))?.isSymbolicLink()
    ? await moveAside(dirname(target), target)
    : null;
  try {
    await replaceDir(staging, target);
  } catch (err) {
    if (oldLink) await putBack(oldLink, target);
    throw err;
  }
  if (oldLink) await rm(oldLink, { force: true });
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

/** A source file or folder that cannot be read would look deleted, so the copy waits for it. */
function unreadableSource(paths: string[]): Error {
  return new Error(`cannot read source file(s): ${paths.join(', ')}`);
}

/** The `dirHash` of a tree from its `readTree` entries: regular files only, as `dirHash` sees it. */
function contentHash(files: FileHashes, links: string[]): string {
  const link = new Set(links);
  return dirHashOf(Object.fromEntries(Object.entries(files).filter(([rel]) => !link.has(rel))));
}

/** Baseline for a marker without `files`: every file of a copy matching the recorded hash,
 *  else the files untouched since that marker was written. Change time, unlike modification
 *  time, cannot be set back, so an edit with a restored timestamp still counts as touched. */
async function legacyBaseline(
  target: string,
  storedHash: string,
  live: FileHashes,
  links: string[],
): Promise<FileHashes> {
  if (contentHash(live, links) === storedHash) return live;
  const projectedAt = (await stat(join(target, PROVENANCE_MARKER))).mtimeMs;
  const untouched: [string, string][] = [];
  for (const [rel, hash] of Object.entries(live)) {
    const { mtimeMs, ctimeMs } = await lstat(join(target, rel));
    if (Math.max(mtimeMs, ctimeMs) <= projectedAt) untouched.push([rel, hash]);
  }
  return Object.fromEntries(untouched);
}

/** What a per-file comparison of an existing projection against its source concluded. */
type Reconciled = {
  /** Empty folders in the copy when it was compared. */
  emptyFolders: string[];
  /** Empty folders the source has and the copy lacks. */
  foldersToCreate: string[];
  /** Every empty folder the source has. */
  sourceEmptyFolders: string[];
  /** Empty folders in the copy that came from the source and that it no longer has. */
  foldersToRemove: string[];
  /** Leftover symlinks at a source FILE path, with the link text each must still hold. */
  fileLeftovers: FileHashes;
  /** Leftover symlinks at a source FOLDER path, with the link text each must still hold. */
  folderLeftovers: FileHashes;
  /** `dirHash` of the source, as recorded in the marker. */
  sourceHash: string;
  sourceFiles: FileHashes;
  /** Content of the projection as it was compared. */
  live: FileHashes;
  /** The per-file baseline the comparison used. */
  baseline: FileHashes;
  /** Baseline to record: the source hash, except a kept file keeps its old entry (or none). */
  files: FileHashes;
  /** Files the user edited, sorted — left exactly as they are. */
  kept: string[];
  /** Source files to copy in: missing or out of date, and not clashing with a kept path. */
  stale: string[];
  /** Unedited files the source no longer has. */
  dropped: string[];
};

/** Compare an existing projection with its source per file. A file differing from both its
 *  baseline and the source is kept; every other path follows the source. */
async function reconcileProjection(
  sourceDir: string,
  target: string,
  stored: Provenance,
): Promise<Reconciled> {
  const [source, copy] = await Promise.all([
    readTree(sourceDir, EXCLUDE_FROM_HASH, true),
    readTree(target, EXCLUDE_FROM_HASH),
  ]);
  if (source.unreadable.length > 0) throw unreadableSource(source.unreadable);
  const sourceFiles = source.files;
  const live = copy.files;
  const baseline = stored.files ?? (await legacyBaseline(target, stored.hash, live, copy.links));
  const leftovers = await leftoverLinks(sourceDir, target, copy.links);
  // A copy file that cannot be read, or any other symlink, is left alone like an edit.
  const kept = [
    ...copy.unreadable,
    ...copy.links.filter((rel) => !Object.hasOwn(leftovers, rel)),
    ...Object.keys(live).filter(
      (rel) => live[rel] !== baseline[rel] && live[rel] !== sourceFiles[rel],
    ),
  ].sort();
  const keep = new Set(kept);
  const split = splitLeftovers(leftovers, sourceFiles);
  const replacedFolders = Object.keys(split.folderLeftovers);
  const stale = Object.keys(sourceFiles).filter(
    (rel) =>
      !keep.has(rel) &&
      live[rel] !== sourceFiles[rel] &&
      !clashesWithKept(rel, kept) &&
      !clashesWithKept(rel, replacedFolders),
  );
  const dropped = Object.keys(live).filter(
    (rel) => !keep.has(rel) && !Object.hasOwn(sourceFiles, rel),
  );
  const files = withKeptEntries(sourceFiles, kept, baseline);
  const sourceHash = dirHashOf(sourceFiles);
  const foldersToCreate = await missingIn(target, source.empty);
  // Only folders the source once had: an empty folder the user made is theirs to keep.
  const foldersToRemove = copy.empty.filter(
    (rel) => (stored.folders ?? []).includes(rel) && !source.empty.includes(rel),
  );
  return {
    sourceHash,
    sourceFiles,
    live,
    baseline,
    files,
    kept,
    stale,
    dropped,
    ...split,
    emptyFolders: copy.empty,
    foldersToCreate,
    foldersToRemove,
    sourceEmptyFolders: source.empty,
  };
}

/** The paths in `rels` that nothing occupies inside `target`. */
async function missingIn(target: string, rels: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const rel of rels) if (!(await lstatOrNull(join(target, rel)))) missing.push(rel);
  return missing;
}

/** True when the copy already matches the source in everything this projection manages. */
function nothingToDo(r: Reconciled): boolean {
  return (
    r.stale.length +
      r.dropped.length +
      Object.keys(r.fileLeftovers).length +
      Object.keys(r.folderLeftovers).length +
      r.foldersToCreate.length +
      r.foldersToRemove.length ===
    0
  );
}

/** The baseline as it stands mid-update: what was compared, plus each change that landed. */
type Progress = { files: FileHashes; folders: string[]; allDone: boolean };

/** Source files under a leftover folder link, which that folder's replacement brings in. */
const underFolderLeftovers = (r: Reconciled): string[] =>
  Object.keys(r.sourceFiles).filter((file) =>
    Object.keys(r.folderLeftovers).some((rel) => file.startsWith(`${rel}/`)),
  );

/** Starting point for `Progress`: settled paths as finally recorded, pending ones as compared. */
function startProgress(r: Reconciled): Progress {
  const files = { ...r.files };
  for (const rel of [...r.stale, ...r.dropped, ...underFolderLeftovers(r)]) {
    if (r.baseline[rel] === undefined) delete files[rel];
    else files[rel] = r.baseline[rel];
  }
  return { files, folders: [...r.sourceEmptyFolders], allDone: true };
}

/** Remove `dropped` files, replace leftover links, copy `stale` files in, and sync empty
 *  folders. Each change that lands is recorded in `p` with the hash of what was placed. */
async function applyChanges(sourceDir: string, target: string, r: Reconciled, p: Progress) {
  await sweepOrphans(dirname(target));
  const record = (placed: Record<string, string | null>) => {
    for (const [rel, hash] of Object.entries(placed)) {
      p.allDone &&= hash !== null;
      if (hash !== null) p.files[rel] = hash;
    }
  };
  for (const [rel, text] of Object.entries(r.folderLeftovers)) {
    const placed = await replaceFolder(sourceDir, target, rel, linkExpectation(text));
    p.allDone &&= placed !== null;
    record(Object.fromEntries(Object.entries(placed ?? {}).map(([f, h]) => [`${rel}/${f}`, h])));
  }
  for (const rel of r.dropped) {
    const ok = await dropFile(target, rel, r.live[rel]);
    p.allDone &&= ok;
    if (ok) delete p.files[rel];
  }
  const empty = new Set(r.emptyFolders);
  for (const rel of r.stale) {
    const link = r.fileLeftovers[rel];
    const expected = link === undefined ? r.live[rel] : linkExpectation(link);
    record({ [rel]: await replaceFile(sourceDir, target, rel, expected, empty.has(rel)) });
  }
  // rmdir only ever removes an empty folder; one it could not remove stays recorded for retry.
  for (const rel of r.foldersToRemove) {
    await rmdir(join(target, rel)).catch(() => p.folders.push(rel));
  }
  // Checked after the file changes, so a file the source turned into a folder gives way first.
  // mkdir never replaces what is already there.
  for (const rel of await missingIn(target, r.sourceEmptyFolders)) {
    if (await throughLink(target, `${rel}/x`)) continue;
    await mkdir(join(target, rel), { recursive: true }).catch(() => {});
  }
}

/**
 * Bring an existing projection in line with its source.
 * Fast path: stat signatures unchanged on BOTH sides → no-op with zero content reads. The
 * fast path may ONLY ever elect a no-op — it never overwrites, so a stat-missed edit
 * (touch -r) stays preserved. Content hashes are the SOLE authority for keep-vs-update.
 */
async function updateProjection(
  skillName: string,
  sourceDir: string,
  target: string,
  stored: Provenance,
): Promise<void> {
  // Taken BEFORE hashing, so a change racing the reconcile is seen by the next projection.
  const sig = await dirStatSig(target, EXCLUDE_FROM_HASH);
  const srcSig = await dirStatSig(sourceDir, EXCLUDE_FROM_HASH, true);
  if (stored.sig === sig && stored.srcSig === srcSig) return;
  const reconciled = await reconcileProjection(sourceDir, target, stored);
  const { sourceHash: hash, files, kept } = reconciled;
  const folders = reconciled.sourceEmptyFolders;
  if (nothingToDo(reconciled)) {
    // Nothing to copy. Re-record the signatures so the next projection takes the fast path.
    await writeProvenance(target, { hash, sig, srcSig, files, folders });
    return;
  }
  const progress = startProgress(reconciled);
  let finished = false;
  try {
    await applyChanges(sourceDir, target, reconciled, progress);
    finished = true;
  } finally {
    // No signature after a merge, so the next run re-checks it. An update that stopped part
    // way records exactly what landed, so nothing it did is later mistaken for an edit.
    const complete = finished && progress.allDone;
    await writeProvenance(target, {
      hash: complete ? hash : stored.hash,
      srcSig: complete ? srcSig : undefined,
      files: progress.files,
      folders: progress.folders,
    });
  }
  if (kept.length > 0) {
    log.warn(
      `[skill-projection] ${skillName}: updated ${target} but kept ${kept.length} locally edited file(s): ${kept.join(', ')}. Delete a file to take the source version.`,
    );
  }
}

async function projectToTarget(
  sourceDir: string,
  baseDir: string,
  skillName: string,
): Promise<void> {
  await ensureDirExistsAsync(baseDir);
  const target = join(baseDir, skillName);

  const lst = await lstatOrNull(target);
  // An existing symlink (incl. a dangling one) migrates to a real copy: `copyInto` stages the
  // copy in full and only then swaps the link out.
  if (lst?.isSymbolicLink()) {
    // fall through to a fresh copy
  } else if (lst && !isFrinkProjection(target)) {
    // User-authored real dir — never clobber.
    log.info(`[skill-projection] ${skillName}: non-frink skill dir at ${target}; skipping`);
    return;
  } else if (lst) {
    // A marker that cannot be read or parsed tells nothing about edits, not even when it was
    // written, so every file that differs from the source is kept; missing ones are restored.
    const stored = (await readProvenance(target)) ?? { hash: '', files: {} };
    return updateProjection(skillName, sourceDir, target, stored);
  }
  await sweepOrphans(baseDir); // clear crash debris before we stage a new copy
  await copyInto(sourceDir, target, await dirStatSig(sourceDir, EXCLUDE_FROM_HASH, true));
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
