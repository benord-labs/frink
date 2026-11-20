import { join, resolve } from 'node:path';
import { frinkUserHome } from './platform/frink-home';

/**
 * Resolved absolute path to ~/.frink/skills/ — the source of truth for
 * Frink-managed skill assets the app ships + provisions. The per-tool dirs
 * (`getUniversalSkillDirs`) hold REAL COPIES projected from here.
 *
 * Lazy (function, not a top-level const like `frink-custom-nodes-dir.ts`):
 * `skill-provisioner`'s tests swap `process.env.HOME` at runtime and resolve
 * paths per-call, so a frozen constant would point at the wrong home.
 */
export function getFrinkSkillsDir(): string {
  return resolve(join(frinkUserHome(), '.frink', 'skills'));
}

/** Skill dirs READ under `base`, in precedence order (an earlier dir wins a name clash). */
export function skillSourceDirsFor(base: string): string[] {
  return [
    join(base, '.agents', 'skills'),
    join(base, '.claude', 'skills'),
    join(base, '.cursor', 'skills'),
  ];
}

/** The machine-local skill source dirs (`skillSourceDirsFor(frinkUserHome())`). Lazy for the home-per-call reason above. */
export function getUniversalSkillSources(): string[] {
  return skillSourceDirsFor(frinkUserHome());
}

/** Where Frink projects REAL COPIES. Not `~/.cursor/skills`: Cursor reads these two itself, and a
 *  copy there would shadow or outlive the original. */
export function getUniversalSkillDirs(): string[] {
  return getUniversalSkillSources().filter((dir) => dir !== getCursorSkillsDir());
}

/** Cursor's own user skills dir: read as a source, never projected into. */
export function getCursorSkillsDir(): string {
  return join(frinkUserHome(), '.cursor', 'skills');
}

/**
 * The dirs the permission checker SEARCHES for a frink-shipped skill on a Read
 * auto-allow: the canonical store plus every per-tool skill dir. Containment in
 * one of these is necessary but NOT sufficient — the checker additionally requires
 * the skill dir to carry the frink baseline marker (`checkEdit`/`isFrinkShippedSkillRead`),
 * so a user's own skill sitting in the same dir still prompts. Once skills are real
 * copies (not symlinks into `~/.frink/skills`) a projected read realpaths to itself,
 * which is why every home — not just the canonical store — has to be searched.
 */
export function getSkillReadRoots(): string[] {
  return [getFrinkSkillsDir(), ...getUniversalSkillSources()];
}
