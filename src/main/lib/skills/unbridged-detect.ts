import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { IDE_DIRS_PRIORITY, UNIVERSAL_DIR } from '../agents';
import { isMappedTool, readableByTool } from '../agents/follows-you';
import { isFrinkProjection, isFrinkShipped } from './skill-projection';

/**
 * Project-scoped user skills the SPAWNING tool can't read — the chat-open "copy across?" prompt set.
 * Scans `<projectPath>/.claude|.cursor|.agents/skills` for user skills (SKILL.md, not Frink-managed),
 * groups by name, and returns those NONE of whose copies sit in a dir `tool` reads. One
 * `{name, sourcePath}` per name (`sourcePath` = the first copy, to copy FROM). Fail-safe: an unmapped tool
 * or unreadable dir yields `[]` (never throws, never a false "unbridged").
 */
/** Add the user-authored skills under one `<base>/skills` dir to the name→paths map. */
async function addUserSkillsFrom(base: string, byName: Map<string, string[]>): Promise<void> {
  if (!existsSync(base)) return;
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return;
  }
  for (const name of entries) {
    const dir = join(base, name);
    if (!existsSync(join(dir, 'SKILL.md')) || isFrinkProjection(dir) || isFrinkShipped(dir))
      continue;
    const list = byName.get(name);
    if (list) list.push(dir);
    else byName.set(name, [dir]);
  }
}

export async function detectUnbridgedProjectSkills(
  projectPath: string,
  tool: string,
): Promise<{ name: string; sourcePath: string }[]> {
  if (!isMappedTool(tool)) return [];

  const dirs = [...IDE_DIRS_PRIORITY, UNIVERSAL_DIR]
    .filter((d) => d !== '.frink') // Frink's internal home is not a user tool dir
    .map((d) => join(projectPath, d, 'skills'));

  const byName = new Map<string, string[]>(); // logical name → copy paths
  for (const base of dirs) await addUserSkillsFrom(base, byName);

  const out: { name: string; sourcePath: string }[] = [];
  for (const [name, paths] of byName) {
    if (!paths.some((p) => readableByTool(p, tool))) out.push({ name, sourcePath: paths[0] });
  }
  return out;
}
