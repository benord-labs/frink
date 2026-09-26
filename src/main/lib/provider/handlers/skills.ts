import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import log from 'electron-log';
import { getUniversalSkillDirs } from '../../frink-skills-dir';
import { isFrinkProjection, isFrinkShipped, projectSkill } from '../../skills/skill-projection';
import type { CategoryHandler } from './types';

/**
 * Project USER-authored skills (real copies) to the universal targets so they
 * follow the user across tools. Frink-shipped skills are owned by the boot
 * provisioner (so this never races it), and our own projected copies are excluded
 * from the source set so a projection is never re-read as a fresh source on the
 * next run. Provider-agnostic. (Provider config hub, epic 831.)
 *
 * The discovery sources are the same per-tool dirs the projection writes to
 * (`getUniversalSkillDirs`) — a skill authored in any one follows to the rest.
 *
 * Codex (`skills: 'copy'`) needs NO dedicated target: its primary user-skills root is
 * `~/.agents/skills` (verified in core-skills loader; `~/.codex/skills` is its DEPRECATED
 * back-compat location), and `~/.agents/skills` is already in `getUniversalSkillDirs`.
 */

/** A real, user-authored skill = has SKILL.md and is NOT frink-managed (projection or shipped). */
function isUserSkill(dir: string): boolean {
  return (
    existsSync(join(dir, 'SKILL.md')) &&
    !isFrinkProjection(dir) && // a copy we wrote — don't re-read it as a source
    !isFrinkShipped(dir) // frink-shipped (provisioner owns it)
  );
}

export const deliverSkills: CategoryHandler = async ({ mode, ctx }) => {
  const seen = new Set<string>();
  let projected = 0;
  for (const base of getUniversalSkillDirs()) {
    let names: string[];
    try {
      names = await readdir(base);
    } catch {
      continue; // dir doesn't exist on this machine
    }
    for (const name of names) {
      if (seen.has(name)) continue;
      const src = join(base, name);
      if (!isUserSkill(src)) continue;
      seen.add(name);
      try {
        await projectSkill(name, src);
        projected += 1;
      } catch (err) {
        log.warn(`[provider] deliver:skills skip ${name}: ${String(err)}`);
      }
    }
  }
  log.info(`[provider] deliver:skills → ${ctx.provider}: ${projected} user skill(s) projected`);
  return {
    category: 'skills',
    mode,
    status: 'delivered',
    detail: `projected ${projected} user skill(s)`,
  };
};
