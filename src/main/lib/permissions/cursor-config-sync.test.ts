import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addBashRuleToCursorConfig,
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
