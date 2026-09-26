import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathCommittable } from './git-utils';

describe('isPathCommittable', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-committable-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('not a git repo → false (machine-local, no warning)', async () => {
    expect(await isPathCommittable(dir, '.claude/skills')).toBe(false);
  });

  it('git repo + path NOT gitignored → true (a copy here would be committable)', async () => {
    execSync('git init -q', { cwd: dir });
    expect(await isPathCommittable(dir, '.claude/skills')).toBe(true);
  });

  it('git repo + path gitignored → false (effectively machine-local)', async () => {
    execSync('git init -q', { cwd: dir });
    await fs.writeFile(path.join(dir, '.gitignore'), '.claude/\n');
    expect(await isPathCommittable(dir, '.claude/skills')).toBe(false);
  });
});
