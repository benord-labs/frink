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

/**
 * The machine-local per-tool skill dirs that hold REAL COPIES projected from
 * `~/.frink/skills`: `~/.agents/skills` (universal — Cursor/opencode/Codex/Gemini),
 * `~/.claude/skills` (Claude), `~/.cursor/skills` (Cursor's shipped path). Single
 * definition of the projection targets — `skill-projection.getSkillTargetDirs`
 * and the permission checker's read-roots both consume this. Lazy for the same
 * home-per-call reason as above.
 */
/**
 * The per-tool skill dirs under a given base: `<base>/.agents|.claude|.cursor/skills`. `base = frinkUserHome()`
 * is the machine-local universal set; `base = <projectPath>` targets a project's own tool dirs (used by the
 * user-initiated "copy across" to a project — see `provider-config-canonical-home`).
 */
export function skillTargetDirsFor(base: string): string[] {
  return [
    join(base, '.agents', 'skills'),
    join(base, '.claude', 'skills'),
    join(base, '.cursor', 'skills'),
  ];
}

export function getUniversalSkillDirs(): string[] {
  return skillTargetDirsFor(frinkUserHome());
}

/**
 * The dirs the permission checker SEARCHES for a frink-shipped skill on a Read
 * auto-allow: the canonical store plus the per-tool real-copy dirs. Containment in
 * one of these is necessary but NOT sufficient — the checker additionally requires
 * the skill dir to carry the frink baseline marker (`checkEdit`/`isFrinkShippedSkillRead`),
 * so a user's own skill sitting in the same dir still prompts. Once skills are real
 * copies (not symlinks into `~/.frink/skills`) a projected read realpaths to itself,
 * which is why every home — not just the canonical store — has to be searched.
 */
export function getSkillReadRoots(): string[] {
  return [getFrinkSkillsDir(), ...getUniversalSkillDirs()];
}
