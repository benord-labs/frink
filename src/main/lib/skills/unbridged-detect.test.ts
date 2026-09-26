import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectUnbridgedProjectSkills } from './unbridged-detect';

describe('detectUnbridgedProjectSkills', () => {
  let proj: string;
  const mkSkill = async (dir: string, name: string): Promise<string> => {
    const d = path.join(proj, dir, 'skills', name);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'SKILL.md'), `---\nname: ${name}\n---\nbody\n`);
    return d;
  };
  beforeEach(async () => {
    proj = await fs.mkdtemp(path.join(os.tmpdir(), 'unbridged-'));
  });
  afterEach(async () => {
    await fs.rm(proj, { recursive: true, force: true });
  });

  it('a .cursor-only project skill is un-bridged for Claude (Claude reads only .claude)', async () => {
    const src = await mkSkill('.cursor', 'foo');
    expect(await detectUnbridgedProjectSkills(proj, 'claude-code')).toEqual([
      { name: 'foo', sourcePath: src },
    ]);
  });

  it('a skill already in .claude is NOT un-bridged for Claude', async () => {
    await mkSkill('.claude', 'foo');
    expect(await detectUnbridgedProjectSkills(proj, 'claude-code')).toEqual([]);
  });

  it('a .cursor skill is readable by Cursor → not un-bridged', async () => {
    await mkSkill('.cursor', 'foo');
    expect(await detectUnbridgedProjectSkills(proj, 'cursor')).toEqual([]);
  });

  it('.agents-only is un-bridged for Claude (Claude does not read .agents)', async () => {
    await mkSkill('.agents', 'foo');
    expect((await detectUnbridgedProjectSkills(proj, 'claude-code')).map((s) => s.name)).toEqual([
      'foo',
    ]);
  });

  it('an unmapped tool (github) → [] (fail-safe, never a false prompt)', async () => {
    await mkSkill('.cursor', 'foo');
    expect(await detectUnbridgedProjectSkills(proj, 'github')).toEqual([]);
  });
});
