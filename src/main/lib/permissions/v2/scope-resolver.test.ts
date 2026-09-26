import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projects } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { resolveScopes } from './scope-resolver';
import { addProjectRule, addUserRule } from './store-local';
import { __resetPolicyCache } from './store-policy';
import type { PermissionRequest } from './types';

const makeReq = (over: Partial<PermissionRequest>): PermissionRequest => ({
  tool: 'Bash',
  input: { command: 'true' },
  projectId: 'p',
  projectPath: '/p',
  ...over,
});

async function seedProject(db: TestDb, name = 'p'): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, path: `/tmp/${name}-${crypto.randomUUID()}` })
    .returning();
  return row.id;
}

let policyTmpDir: string;
let policyCounter = 0;
async function writePolicyFile(content: string): Promise<string> {
  if (!policyTmpDir) policyTmpDir = await mkdtemp(join(tmpdir(), 'frink-resolver-policy-'));
  const path = join(policyTmpDir, `policy-${policyCounter++}.json`);
  await writeFile(path, content, 'utf-8');
  return path;
}

describe('resolveScopes', () => {
  let db: TestDb;
  let prevEnv: string | undefined;
  beforeEach(() => {
    db = freshDb();
    __resetPolicyCache();
    prevEnv = process.env.FRINK_MANAGED_PERMISSIONS_PATH;
    delete process.env.FRINK_MANAGED_PERMISSIONS_PATH;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.FRINK_MANAGED_PERMISSIONS_PATH;
    else process.env.FRINK_MANAGED_PERMISSIONS_PATH = prevEnv;
  });

  it('returns empty ScopedDocs when nothing is configured', async () => {
    const res = await resolveScopes(db, makeReq({ projectId: 'p' }));
    expect(res).toEqual({
      policy: { allow: [], deny: [], ask: [] },
      project: { allow: [], deny: [], ask: [] },
      user: { allow: [], deny: [], ask: [] },
    });
  });

  it('populates user tier when only user rules exist', async () => {
    await addUserRule(db, 'Bash(npm:*)', 'allow');
    const res = await resolveScopes(db, makeReq({ projectId: 'p1' }));
    expect(res.user.allow).toEqual(['Bash(npm:*)']);
    expect(res.project.allow).toEqual([]);
    expect(res.policy.allow).toEqual([]);
  });

  it('populates project tier independently', async () => {
    const projectId = await seedProject(db);
    await addProjectRule(db, projectId, 'Edit(src/**)', 'allow');
    const res = await resolveScopes(db, makeReq({ projectId }));
    expect(res.project.allow).toEqual(['Edit(src/**)']);
    expect(res.user.allow).toEqual([]);
  });

  it('populates policy tier from FRINK_MANAGED_PERMISSIONS_PATH', async () => {
    const policyPath = await writePolicyFile(
      JSON.stringify({ permissions: { deny: ['Bash(rm -rf:*)'] } }),
    );
    process.env.FRINK_MANAGED_PERMISSIONS_PATH = policyPath;
    __resetPolicyCache();
    const res = await resolveScopes(db, makeReq({}));
    expect(res.policy.deny).toEqual(['Bash(rm -rf:*)']);
  });

  it('a stored deny still resolves', async () => {
    await addUserRule(db, 'Bash(rm:*)', 'deny');
    const res = await resolveScopes(db, makeReq({ projectId: 'p' }));
    expect(res.user.deny).toEqual(['Bash(rm:*)']);
  });

  it('nonexistent projectId returns empty project doc without error', async () => {
    const res = await resolveScopes(db, makeReq({ projectId: 'ghost' }));
    expect(res.project).toEqual({ allow: [], deny: [], ask: [] });
  });
});
