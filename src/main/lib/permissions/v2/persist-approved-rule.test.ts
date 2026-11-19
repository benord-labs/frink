import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { persistApprovedRule } from './persist-approved-rule';
import { getProjectDoc } from './store-local';

let db: TestDb;
let projectPath: string;

/** Every path under `dir` with its contents, so any added, removed or edited file shows up. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(dir, path.join(entry.parentPath, entry.name));
    out[rel] = entry.isDirectory() ? '<dir>' : await readFile(path.join(dir, rel), 'utf8');
  }
  return out;
}

beforeEach(async () => {
  db = freshDb();
  projectPath = await mkdtemp(path.join(os.tmpdir(), 'persist-rule-'));
  await writeFile(path.join(projectPath, 'package.json'), '{}\n');
});
afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe('persistApprovedRule', () => {
  it.each([
    ['with an existing .cursor/cli.json', true],
    ['with no .cursor folder', false],
  ])('saves a project Bash rule without touching the repo (%s)', async (_label, seeded) => {
    if (seeded) {
      await mkdir(path.join(projectPath, '.cursor'));
      await writeFile(
        path.join(projectPath, '.cursor', 'cli.json'),
        '{"permissions":{"allow":["Shell(ls)"],"deny":[]}}\n',
      );
    }
    const [project] = await db
      .insert(projects)
      .values({ name: 'p', path: projectPath })
      .returning();
    const before = await snapshot(projectPath);

    await persistApprovedRule({
      db,
      projectPath,
      project: { id: project.id },
      promptResult: { scope: 'project', ruleString: 'Bash(npm:*)', ruleType: 'allow' },
      logTag: '[test]',
    });

    expect((await getProjectDoc(db, project.id)).allow).toContain('Bash(npm:*)');
    expect(await snapshot(projectPath)).toEqual(before);
  });
});
