/** Removes the copies Frink used to write into `~/.cursor/skills`, which Cursor's own reads of
 *  `~/.agents` and `~/.claude` made redundant. Only unedited Frink copies go; runs every boot. */

import { existsSync } from 'node:fs';
import { readdir, readlink, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import log from 'electron-log';
import { getCursorSkillsDir, getFrinkSkillsDir, getUniversalSkillDirs } from '../frink-skills-dir';
import { readTree } from './skill-fs';
import { lstatOrNull, moveAside, putBack } from './skill-guarded-write';
import {
  EXCLUDE_FROM_HASH,
  isFrinkShipped,
  legacyBaseline,
  PROVENANCE_MARKER,
  projectionMutex,
} from './skill-projection';
import {
  adoptedProvenance,
  type Provenance,
  readProvenance,
  sameDir,
} from './skill-projection-compare';

type Outcome = 'removed' | 'kept' | 'skipped';

/** Frink's crash-debris suffix (a millisecond stamp), stripped only to find the skill it came from. */
const DEBRIS_SUFFIX = /\.(?:staging-\d+-\d{13,}|old-\d{13,})$/;
/** A whole skill folder a stopped run moved aside; put back by name, never deleted by it. */
const STRANDED_ASIDE = /^(.+)\.frink-aside-[0-9a-f-]{36}$/;

/** What Frink recorded writing into `dir`; null when that cannot be proven (no marker, or one
 *  that cannot be read), so the folder is left alone. */
async function frinkRecord(dir: string): Promise<Provenance | null> {
  const marker = join(dir, PROVENANCE_MARKER);
  if (existsSync(marker)) return readProvenance(marker);
  if (isFrinkShipped(dir)) return adoptedProvenance(dir).catch(() => null);
  return null;
}

/** True when every file in `dir` is exactly what Frink recorded: no edited or added file, no
 *  link, nothing unreadable. A file the user deleted leaves nothing to keep. */
async function unedited(dir: string, stored: Provenance): Promise<boolean> {
  const tree = await readTree(dir, EXCLUDE_FROM_HASH);
  if (tree.links.length > 0 || tree.unreadable.length > 0) return false;
  if (tree.empty.some((rel) => !(stored.folders ?? []).includes(rel))) return false;
  const baseline = stored.files ?? (await legacyBaseline(dir, stored.hash, tree.files, tree.links));
  return Object.entries(tree.files).every(([rel, hash]) => baseline[rel] === hash);
}

/** Cursor still reads the skill from a projection target, so this copy is not its last one. */
function readableElsewhere(dir: string): boolean {
  const name = basename(dir).replace(DEBRIS_SUFFIX, '');
  return getUniversalSkillDirs().some((target) => existsSync(join(target, name, 'SKILL.md')));
}

/** An old install's link into Frink's own store; links anywhere else are the user's. */
async function isStoreLink(dir: string): Promise<boolean> {
  const text = await readlink(dir);
  return resolve(dirname(dir), text).startsWith(getFrinkSkillsDir() + sep);
}

async function removeOne(dir: string): Promise<Outcome> {
  const st = await lstatOrNull(dir);
  if (st?.isSymbolicLink()) {
    if (!(await isStoreLink(dir)) || !readableElsewhere(dir)) return 'skipped';
    await unlink(dir);
    return 'removed';
  }
  if (!st?.isDirectory()) return 'skipped';
  const stored = await frinkRecord(dir);
  if (!stored || !readableElsewhere(dir)) return 'skipped';
  if (!(await unedited(dir, stored))) return 'kept';
  // Checked again once moved aside: an edit saved meanwhile, or another copy that was only a link
  // into this one (it now dangles) or was deleted meanwhile, puts it back.
  const aside = await moveAside(dir, dir);
  if (!aside) return 'skipped';
  let clean = false;
  try {
    clean = (await unedited(aside, stored)) && readableElsewhere(dir);
  } finally {
    if (clean) await rm(aside, { recursive: true, force: true });
    else await putBack(aside, dir);
  }
  return clean ? 'removed' : 'kept';
}

/** True when Cursor's folder is, through a link, Frink's store or a folder Frink projects into. */
async function isATarget(base: string): Promise<boolean> {
  for (const target of [getFrinkSkillsDir(), ...getUniversalSkillDirs()]) {
    if (await sameDir(base, target).catch(() => false)) return true;
  }
  return false;
}

async function restoreStranded(base: string, names: string[]): Promise<void> {
  for (const name of names) {
    const original = STRANDED_ASIDE.exec(name)?.[1];
    if (!original) continue;
    try {
      if ((await lstatOrNull(join(base, name)))?.isDirectory()) {
        await putBack(join(base, name), join(base, original));
      }
    } catch (err) {
      log.warn(`[skill-projection] could not put back ${name}: ${String(err)}`);
    }
  }
}

export async function removeFrinkCursorSkills(): Promise<void> {
  const base = getCursorSkillsDir();
  await projectionMutex.runExclusive(async () => {
    const found = await readdir(base).catch(() => null);
    if (!found || (await isATarget(base))) return; // absent, or its copies are live projections
    await restoreStranded(base, found);
    // Crash debris passes the same proof as any copy: nothing is deleted by its name alone.
    for (const name of await readdir(base).catch(() => [])) {
      const dir = join(base, name);
      try {
        const outcome = await removeOne(dir);
        if (outcome === 'removed') log.info(`[skill-projection] removed Frink's old copy ${dir}`);
        if (outcome === 'kept') {
          log.warn(
            `[skill-projection] kept ${dir}: Frink wrote it but it holds your edits. Delete it if Cursor should read only the ~/.agents or ~/.claude copy.`,
          );
        }
      } catch (err) {
        log.warn(`[skill-projection] could not clean ${dir}: ${String(err)}`);
      }
    }
  });
}
