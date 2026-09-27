import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addBashRuleToCursorConfig,
  reconcileBashRuleInCursorConfig,
  removeBashRuleFromCursorConfig,
  ruleStringToCursorToken,
} from './cursor-config-sync';

let projectPath: string;
beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), 'frink-cursor-'));
});

const cliJsonPath = (root: string) => join(root, '.cursor', 'cli.json');

async function readConfig(root: string) {
  return JSON.parse(await readFile(cliJsonPath(root), 'utf-8')) as {
    permissions: { allow: string[]; deny: string[] };
  };
}

describe('ruleStringToCursorToken', () => {
  it('Bash(npm:*) → Shell(npm)', () => {
    expect(ruleStringToCursorToken('Bash(npm:*)')).toBe('Shell(npm)');
  });

  it('Bash(git:*) → Shell(git)', () => {
    expect(ruleStringToCursorToken('Bash(git:*)')).toBe('Shell(git)');
  });

  it('Bash(git push:*) → null (cursor cannot express subcommands)', () => {
    expect(ruleStringToCursorToken('Bash(git push:*)')).toBeNull();
  });

  it('no rule other than Bash(npm:*) can yield Shell(npm) (token ↔ rule is 1:1)', () => {
    const variants = [
      'Bash(npm run:*)',
      'Bash(npm)',
      'Bash(npm *)',
      'Bash( npm:*)',
      'Bash(npm:*:*)',
    ];
    for (const rule of variants) expect(ruleStringToCursorToken(rule)).not.toBe('Shell(npm)');
  });

  it.each([' Bash(npm:*) ', '\tBash(npm:*)', 'Bash(npm:*)\n', '  \r\nBash(npm:*)  '])(
    'tolerates surrounding whitespace that validateRuleString accepts: %j → Shell(npm)',
    (rule) => {
      expect(ruleStringToCursorToken(rule)).toBe('Shell(npm)');
    },
  );

  it('Bash(echo hello) → null (cursor has no exact match)', () => {
    expect(ruleStringToCursorToken('Bash(echo hello)')).toBeNull();
  });

  it('Bash(npm:install:*) → null (post-strip base contains colon = dead token)', () => {
    expect(ruleStringToCursorToken('Bash(npm:install:*)')).toBeNull();
  });

  it('Bash (tool-wide) → null', () => {
    expect(ruleStringToCursorToken('Bash')).toBeNull();
  });

  it('Edit(src/**) → null', () => {
    expect(ruleStringToCursorToken('Edit(src/**)')).toBeNull();
  });

  it('Write(src/**) → null', () => {
    expect(ruleStringToCursorToken('Write(src/**)')).toBeNull();
  });

  it('mcp__shortcut__create → null', () => {
    expect(ruleStringToCursorToken('mcp__shortcut__create')).toBeNull();
  });

  it('garbage / empty input → null', () => {
    expect(ruleStringToCursorToken('garbage(')).toBeNull();
    expect(ruleStringToCursorToken('')).toBeNull();
  });

  it('Bash(:*) → null (empty base after strip)', () => {
    expect(ruleStringToCursorToken('Bash(:*)')).toBeNull();
  });

  it('Bash(*:*) → null (would write Shell(*) which cursor treats as wildcard)', () => {
    expect(ruleStringToCursorToken('Bash(*:*)')).toBeNull();
  });

  it('Bash(?:*) → null (single-char wildcard)', () => {
    expect(ruleStringToCursorToken('Bash(?:*)')).toBeNull();
  });
});

describe('addBashRuleToCursorConfig', () => {
  it('writes Shell(npm) for Bash(npm:*)', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toContain('Shell(npm)');
  });

  it('creates .cursor/cli.json when missing', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    expect(existsSync(cliJsonPath(projectPath))).toBe(true);
  });

  it('dedups: adding the same rule twice yields one entry', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow.filter((s) => s === 'Shell(npm)')).toHaveLength(1);
  });

  it('no-op when rule is unmappable (Bash(git push:*))', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(git push:*)');
    expect(existsSync(cliJsonPath(projectPath))).toBe(false);
  });

  it('no-op for non-Bash rules', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Edit(src/**)');
    expect(existsSync(cliJsonPath(projectPath))).toBe(false);
  });

  it('preserves other entries when adding a new one', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await addBashRuleToCursorConfig(projectPath, 'Bash(git:*)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(npm)', 'Shell(git)']);
  });

  it('writes a trailing newline (POSIX + biome formatter)', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    const raw = await readFile(cliJsonPath(projectPath), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('removeBashRuleFromCursorConfig', () => {
  it('removes the matching Shell(...) entry', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await addBashRuleToCursorConfig(projectPath, 'Bash(git:*)');
    await removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(git)']);
  });

  it('idempotent: removing absent rule is a no-op', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await removeBashRuleFromCursorConfig(projectPath, 'Bash(git:*)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(npm)']);
  });

  it('no-op when .cursor/cli.json does not exist', async () => {
    await expect(
      removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)'),
    ).resolves.toBeUndefined();
    expect(existsSync(cliJsonPath(projectPath))).toBe(false);
  });

  it('no-op when rule is unmappable', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await removeBashRuleFromCursorConfig(projectPath, 'Bash(git push:*)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(npm)']);
  });
});

describe('readCursorConfig tolerance', () => {
  it('coerces non-array permissions.allow/deny to [] without crashing on add', async () => {
    await mkdir(join(projectPath, '.cursor'), { recursive: true });
    await writeFile(
      cliJsonPath(projectPath),
      JSON.stringify({ permissions: { allow: null, deny: 'oops' } }),
      'utf-8',
    );
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(npm)']);
    expect(Array.isArray(cfg.permissions.deny)).toBe(true);
  });
});

describe('removeBashRuleFromCursorConfig — revoke edge cases (sc-3267)', () => {
  it('removes every duplicate of the token (hand-edited file) so the revoke is complete', async () => {
    await mkdir(join(projectPath, '.cursor'), { recursive: true });
    await writeFile(
      cliJsonPath(projectPath),
      JSON.stringify({
        permissions: { allow: ['Shell(npm)', 'Shell(git)', 'Shell(npm)'], deny: [] },
      }),
      'utf-8',
    );
    await removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(git)']);
  });

  it('preserves unrelated top-level keys and the deny list of a real Cursor cli.json', async () => {
    await mkdir(join(projectPath, '.cursor'), { recursive: true });
    await writeFile(
      cliJsonPath(projectPath),
      JSON.stringify({
        version: 1,
        editor: { vimMode: true },
        permissions: { allow: ['Shell(npm)', 'Read(**)'], deny: ['Shell(rm)'] },
      }),
      'utf-8',
    );
    await removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)');
    const cfg = JSON.parse(await readFile(cliJsonPath(projectPath), 'utf-8'));
    expect(cfg).toEqual({
      version: 1,
      editor: { vimMode: true },
      permissions: { allow: ['Read(**)'], deny: ['Shell(rm)'] },
    });
  });

  it('never overwrites a malformed cli.json it could not parse', async () => {
    await mkdir(join(projectPath, '.cursor'), { recursive: true });
    await writeFile(cliJsonPath(projectPath), '{ "permissions": { "allow": ["Shell(npm)"', 'utf-8');
    await removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)');
    expect(await readFile(cliJsonPath(projectPath), 'utf-8')).toBe(
      '{ "permissions": { "allow": ["Shell(npm)"',
    );
  });

  it('does not strip a Shell token for a narrower rule that cursor cannot represent', async () => {
    // Revoking Bash(npm test) must not remove Shell(npm), which Bash(npm:*) still backs.
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await removeBashRuleFromCursorConfig(projectPath, 'Bash(npm test)');
    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(npm)']);
  });
});

describe('cursor config writes — concurrency (sc-3267)', () => {
  it('two concurrent revokes of different rules both take effect (no lost update)', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await addBashRuleToCursorConfig(projectPath, 'Bash(git:*)');
    await addBashRuleToCursorConfig(projectPath, 'Bash(pnpm:*)');

    await Promise.all([
      removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)'),
      removeBashRuleFromCursorConfig(projectPath, 'Bash(git:*)'),
    ]);

    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(pnpm)']);
  });

  it('a revoke racing a grant for another command keeps both outcomes', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');

    await Promise.all([
      removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)'),
      addBashRuleToCursorConfig(projectPath, 'Bash(git:*)'),
    ]);

    const cfg = await readConfig(projectPath);
    expect(cfg.permissions.allow).toEqual(['Shell(git)']);
  });

  it('concurrent writes to different projects do not block or bleed into each other', async () => {
    const other = await mkdtemp(join(tmpdir(), 'frink-cursor-other-'));
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await addBashRuleToCursorConfig(other, 'Bash(npm:*)');

    await Promise.all([
      removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)'),
      addBashRuleToCursorConfig(other, 'Bash(git:*)'),
    ]);

    expect((await readConfig(projectPath)).permissions.allow).toEqual([]);
    expect((await readConfig(other)).permissions.allow).toEqual(['Shell(npm)', 'Shell(git)']);
  });
});

describe('reconcileBashRuleInCursorConfig — DB-truth under grant/revoke races (sc-3267)', () => {
  it('syncs a whitespace-padded stored rule the same as the trimmed one', async () => {
    await reconcileBashRuleInCursorConfig(projectPath, '  Bash(npm:*) ', async () => true);
    expect((await readConfig(projectPath)).permissions.allow).toEqual(['Shell(npm)']);
    await reconcileBashRuleInCursorConfig(projectPath, '  Bash(npm:*) ', async () => false);
    expect((await readConfig(projectPath)).permissions.allow).toEqual([]);
  });

  it('adds the token when the predicate says the rule is allowed', async () => {
    await reconcileBashRuleInCursorConfig(projectPath, 'Bash(npm:*)', async () => true);
    expect((await readConfig(projectPath)).permissions.allow).toEqual(['Shell(npm)']);
  });

  it('removes the token when the predicate says the rule is gone', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await reconcileBashRuleInCursorConfig(projectPath, 'Bash(npm:*)', async () => false);
    expect((await readConfig(projectPath)).permissions.allow).toEqual([]);
  });

  it('does not consult the DB for an unmappable rule', async () => {
    let asked = false;
    await reconcileBashRuleInCursorConfig(projectPath, 'Bash(git push:*)', async () => {
      asked = true;
      return true;
    });
    expect(asked).toBe(false);
    expect(existsSync(cliJsonPath(projectPath))).toBe(false);
  });

  it('a delayed grant sync after a revoke does not resurrect the token', async () => {
    // Grant wrote the DB row, revoke deleted it; the grant's file sync is queued last.
    let dbAllows = true;
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    dbAllows = false; // revoke's DB delete
    const isAllowed = async () => dbAllows;
    await Promise.all([
      reconcileBashRuleInCursorConfig(projectPath, 'Bash(npm:*)', isAllowed), // revoke sync
      reconcileBashRuleInCursorConfig(projectPath, 'Bash(npm:*)', isAllowed), // grant sync
    ]);
    expect((await readConfig(projectPath)).permissions.allow).toEqual([]);
  });

  it('a re-grant landing between the revoke delete and its sync keeps the token', async () => {
    let dbAllows = false; // revoke deleted the row…
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    dbAllows = true; // …then a re-grant re-inserted it before either sync ran
    const isAllowed = async () => dbAllows;
    await Promise.all([
      reconcileBashRuleInCursorConfig(projectPath, 'Bash(npm:*)', isAllowed),
      reconcileBashRuleInCursorConfig(projectPath, 'Bash(npm:*)', isAllowed),
    ]);
    expect((await readConfig(projectPath)).permissions.allow).toEqual(['Shell(npm)']);
  });

  it('a throwing predicate rejects without writing, and the queue keeps working', async () => {
    await addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
    await expect(
      reconcileBashRuleInCursorConfig(projectPath, 'Bash(npm:*)', async () => {
        throw new Error('SQLITE_BUSY');
      }),
    ).rejects.toThrow('SQLITE_BUSY');
    await removeBashRuleFromCursorConfig(projectPath, 'Bash(npm:*)');
    expect((await readConfig(projectPath)).permissions.allow).toEqual([]);
  });
});
