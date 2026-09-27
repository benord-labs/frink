import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { projects } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import {
  addProjectRule,
  addUserRule,
  getProjectDoc,
  getUserDoc,
  hasProjectAllowRuleIgnoringPadding,
  removeProjectRule,
  removeUserRule,
} from './store-local';
import type { RuleType } from './types';

async function seedProject(db: TestDb, name = 'p'): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, path: `/tmp/${name}-${crypto.randomUUID()}` })
    .returning();
  return row.id;
}

describe('store-local — user rules', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('addUserRule then getUserDoc round-trips', async () => {
    await addUserRule(db, 'Bash(npm:*)', 'allow');
    const doc = await getUserDoc(db);
    expect(doc.allow).toContain('Bash(npm:*)');
  });

  it('UNIQUE prevents duplicate add', async () => {
    await addUserRule(db, 'Bash(npm:*)', 'allow');
    await addUserRule(db, 'Bash(npm:*)', 'allow');
    const doc = await getUserDoc(db);
    expect(doc.allow.filter((r) => r === 'Bash(npm:*)')).toHaveLength(1);
  });

  it('addUserRule returns { inserted: true } for new rule, false for duplicate', async () => {
    const first = await addUserRule(db, 'Bash(zsh:*)', 'allow');
    expect(first).toEqual({ inserted: true });
    const second = await addUserRule(db, 'Bash(zsh:*)', 'allow');
    expect(second).toEqual({ inserted: false });
  });

  it('same rule different type coexists', async () => {
    await addUserRule(db, 'Bash(rm:*)', 'allow');
    await addUserRule(db, 'Bash(rm:*)', 'deny');
    const doc = await getUserDoc(db);
    expect(doc.allow).toContain('Bash(rm:*)');
    expect(doc.deny).toContain('Bash(rm:*)');
  });

  it('removeUserRule is idempotent', async () => {
    await removeUserRule(db, 'Bash(npm:*)', 'allow');
    await addUserRule(db, 'Bash(npm:*)', 'allow');
    await removeUserRule(db, 'Bash(npm:*)', 'allow');
    await removeUserRule(db, 'Bash(npm:*)', 'allow');
    const doc = await getUserDoc(db);
    expect(doc.allow).not.toContain('Bash(npm:*)');
  });

  it('returns the canonical empty doc when no rules exist', async () => {
    const doc = await getUserDoc(db);
    expect(doc).toEqual({ allow: [], deny: [], ask: [] });
  });

  it('allow / deny / ask all addressable at machine scope', async () => {
    await addUserRule(db, 'Bash(a:*)', 'allow');
    await addUserRule(db, 'Bash(d:*)', 'deny');
    await addUserRule(db, 'Bash(k:*)', 'ask');
    const doc = await getUserDoc(db);
    expect(doc.allow).toEqual(['Bash(a:*)']);
    expect(doc.deny).toEqual(['Bash(d:*)']);
    expect(doc.ask).toEqual(['Bash(k:*)']);
  });

  it('rules return in insertion order (rowid tiebreak when timestamps collide)', async () => {
    await addUserRule(db, 'Bash(c:*)', 'allow');
    await addUserRule(db, 'Bash(a:*)', 'allow');
    await addUserRule(db, 'Bash(b:*)', 'allow');
    const doc = await getUserDoc(db);
    expect(doc.allow).toEqual(['Bash(c:*)', 'Bash(a:*)', 'Bash(b:*)']);
  });

  it('rule strings with escape characters round-trip unchanged', async () => {
    const rule = 'Bash(echo \\(\\) "hello\\nworld")';
    await addUserRule(db, rule, 'allow');
    const doc = await getUserDoc(db);
    expect(doc.allow).toContain(rule);
  });

  it('CHECK constraint rejects invalid rule_type', async () => {
    // SAFETY: the column CHECK is the subject; RuleType cannot express the value that violates it.
    await expect(addUserRule(db, 'Bash(npm:*)', 'invalid' as RuleType)).rejects.toThrow();
  });
});

describe('store-local — project rules', () => {
  let db: TestDb;
  let projectId: string;

  beforeEach(async () => {
    db = freshDb();
    projectId = await seedProject(db);
  });

  it('addProjectRule then getProjectDoc round-trips', async () => {
    await addProjectRule(db, projectId, 'Edit(src/**)', 'allow');
    const doc = await getProjectDoc(db, projectId);
    expect(doc.allow).toContain('Edit(src/**)');
  });

  it('UNIQUE prevents duplicate add', async () => {
    await addProjectRule(db, projectId, 'Bash(git:*)', 'allow');
    await addProjectRule(db, projectId, 'Bash(git:*)', 'allow');
    const doc = await getProjectDoc(db, projectId);
    expect(doc.allow.filter((r) => r === 'Bash(git:*)')).toHaveLength(1);
  });

  it('addProjectRule returns { inserted: true } for new rule, false for duplicate', async () => {
    const first = await addProjectRule(db, projectId, 'Bash(yarn:*)', 'allow');
    expect(first).toEqual({ inserted: true });
    const second = await addProjectRule(db, projectId, 'Bash(yarn:*)', 'allow');
    expect(second).toEqual({ inserted: false });
  });

  it('removeProjectRule is idempotent', async () => {
    await addProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    await removeProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    await removeProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    const doc = await getProjectDoc(db, projectId);
    expect(doc.allow).not.toContain('Bash(npm:*)');
  });

  it('project scope isolation', async () => {
    const otherProjectId = await seedProject(db, 'p2');
    await addProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    const doc = await getProjectDoc(db, otherProjectId);
    expect(doc.allow).toEqual([]);
  });

  it('CASCADE delete: removing project removes its rules', async () => {
    await addProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    await db.delete(projects).where(eq(projects.id, projectId));
    const doc = await getProjectDoc(db, projectId);
    expect(doc.allow).toEqual([]);
  });

  it('FK rejects rule for non-existent project', async () => {
    await expect(addProjectRule(db, 'ghost', 'Bash(npm:*)', 'allow')).rejects.toThrow();
  });

  it('CHECK constraint rejects invalid rule_type', async () => {
    await expect(
      addProjectRule(db, projectId, 'Bash(npm:*)', 'invalid' as RuleType),
    ).rejects.toThrow();
  });
});

describe('store-local — separation', () => {
  it('user rules and project rules do not collide', async () => {
    const db = freshDb();
    const projectId = await seedProject(db);
    await addUserRule(db, 'Bash(npm:*)', 'allow');
    await addProjectRule(db, projectId, 'Bash(git:*)', 'allow');
    expect((await getUserDoc(db)).allow).toEqual(['Bash(npm:*)']);
    expect((await getProjectDoc(db, projectId)).allow).toEqual(['Bash(git:*)']);
  });
});

describe('store-local — hasProjectAllowRuleIgnoringPadding (sc-3267)', () => {
  let db: TestDb;
  let projectId: string;
  const has = (rule: string, id = projectId) => hasProjectAllowRuleIgnoringPadding(db, id, rule);
  beforeEach(async () => {
    db = freshDb();
    projectId = await seedProject(db);
  });

  it('matches an exact allow rule and nothing else', async () => {
    const other = await seedProject(db, 'other');
    await addProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    await addProjectRule(db, projectId, 'Bash(git:*)', 'deny');
    expect(await has('Bash(npm:*)')).toBe(true);
    expect(await has('Bash(git:*)')).toBe(false); // deny does not back an allow token
    expect(await has('Bash(npm run:*)')).toBe(false);
    expect(await has('Bash(npm:*)', other)).toBe(false);
  });

  it.each(['  Bash(npm:*)', 'Bash(npm:*)\t', '\nBash(npm:*)\r\n'])(
    'treats a stored padded variant %j as backing the canonical rule',
    async (stored) => {
      await addProjectRule(db, projectId, stored, 'allow');
      expect(await has('Bash(npm:*)')).toBe(true);
      expect(await has(' Bash(npm:*) ')).toBe(true);
    },
  );

  it('stays true while another padded variant remains after one is removed', async () => {
    await addProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    await addProjectRule(db, projectId, ' Bash(npm:*) ', 'allow');
    await removeProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    expect(await has('Bash(npm:*)')).toBe(true);
    await removeProjectRule(db, projectId, ' Bash(npm:*) ', 'allow');
    expect(await has('Bash(npm:*)')).toBe(false);
  });

  it('does not treat a rule that merely contains the text as a match', async () => {
    await addProjectRule(db, projectId, 'Bash(xBash(npm:*))', 'allow');
    expect(await has('Bash(npm:*)')).toBe(false);
  });

  it('is false for a blank rule', async () => {
    await addProjectRule(db, projectId, 'Bash(npm:*)', 'allow');
    expect(await has('   ')).toBe(false);
  });
});
