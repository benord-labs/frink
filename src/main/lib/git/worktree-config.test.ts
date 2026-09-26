import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectWorktreeConfig,
  executeWorktreeSetup,
  updateWorktreeConfig,
  type WorktreeConfig,
} from './worktree-config';

const tempDirs: string[] = [];

async function createTempProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frink-worktree-config-'));
  tempDirs.push(dir);
  return dir;
}

async function writeFrinkConfig(projectPath: string, config: WorktreeConfig): Promise<void> {
  await writeFrinkFile(projectPath, JSON.stringify(config, null, 2));
}

/** Writes raw file text, for the hand-edited shapes a typed config can't express. */
async function writeFrinkFile(projectPath: string, content: string): Promise<string> {
  const frinkPath = join(projectPath, '.frink', 'worktrees.json');
  await mkdir(dirname(frinkPath), { recursive: true });
  await writeFile(frinkPath, content, 'utf-8');
  return frinkPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('detectWorktreeConfig', () => {
  it('prefers .frink/worktrees.json when present', async () => {
    const projectPath = await createTempProjectDir();
    const frinkPath = join(projectPath, '.frink', 'worktrees.json');

    await mkdir(dirname(frinkPath), { recursive: true });
    await writeFile(
      frinkPath,
      JSON.stringify({ 'setup-worktree': ['bun install'] }, null, 2),
      'utf-8',
    );

    const detected = await detectWorktreeConfig(projectPath);

    expect(detected.source).toBe('frink');
    expect(detected.path).toBe(frinkPath);
    expect(detected.config).toEqual({ 'setup-worktree': ['bun install'] });
  });

  it('returns null when no worktree config exists', async () => {
    const projectPath = await createTempProjectDir();

    const detected = await detectWorktreeConfig(projectPath);

    expect(detected).toEqual({
      config: null,
      path: null,
      source: null,
    });
  });

  // Windows editors (PowerShell 5.1, VS Code "UTF-8 with BOM") prefix a byte-order mark.
  it('reads a file saved with a UTF-8 byte-order mark', async () => {
    const projectPath = await createTempProjectDir();
    await writeFrinkFile(
      projectPath,
      `\uFEFF${JSON.stringify({ 'setup-worktree': ['bun install'] })}`,
    );

    expect((await detectWorktreeConfig(projectPath)).config).toEqual({
      'setup-worktree': ['bun install'],
    });
  });

  it.each<[string, string]>([
    ['a trailing comma', '{ "setup-worktree": ["bun install"], }'],
    ['a top-level list', '["bun install"]'],
    ['an empty file', ''],
    ['a single-string command', '{ "setup-worktree": "bun install" }'],
    ['a non-string command', '{ "setup-worktree": ["bun install", 42] }'],
    ['a non-string location', '{ "worktree-base-path": 5 }'],
  ])('flags a file with %s as unreadable rather than missing', async (_problem, content) => {
    const projectPath = await createTempProjectDir();
    const frinkPath = await writeFrinkFile(projectPath, content);

    expect(await detectWorktreeConfig(projectPath)).toEqual({
      config: null,
      path: frinkPath,
      source: 'frink',
      unreadable: true,
    });
  });
});

describe('updateWorktreeConfig', () => {
  it('creates .frink/worktrees.json with the given keys', async () => {
    const projectPath = await createTempProjectDir();

    const result = await updateWorktreeConfig(projectPath, { 'setup-worktree': ['bun install'] });
    const expectedPath = join(projectPath, '.frink', 'worktrees.json');

    expect(result.path).toBe(expectedPath);
    expect(JSON.parse(await readFile(expectedPath, 'utf-8'))).toEqual({
      'setup-worktree': ['bun install'],
    });
  });

  // The file is shared and often committed: a one-field save must not delete the rest of it,
  // including edits another writer (an agent, git pull) made after the form loaded.
  it('changes only the given keys and keeps everything else in the file', async () => {
    const projectPath = await createTempProjectDir();
    const frinkPath = await writeFrinkFile(
      projectPath,
      JSON.stringify({ $schema: './schema.json', 'setup-worktree': ['bun install', 'cp .env'] }),
    );

    await updateWorktreeConfig(projectPath, { 'worktree-base-path': '/tmp/worktrees' });

    expect(JSON.parse(await readFile(frinkPath, 'utf-8'))).toEqual({
      $schema: './schema.json',
      'setup-worktree': ['bun install', 'cp .env'],
      'worktree-base-path': '/tmp/worktrees',
    });
  });

  it('removes a key saved as empty', async () => {
    const projectPath = await createTempProjectDir();
    const frinkPath = await writeFrinkFile(
      projectPath,
      JSON.stringify({ 'setup-worktree': ['bun install'], 'worktree-base-path': '/tmp/wt' }),
    );

    await updateWorktreeConfig(projectPath, { 'setup-worktree': [], 'worktree-base-path': '' });

    expect(JSON.parse(await readFile(frinkPath, 'utf-8'))).toEqual({});
  });

  // Rewriting a file Frink could not parse would silently replace the user's content.
  it('refuses to overwrite a file it cannot read', async () => {
    const projectPath = await createTempProjectDir();
    const content = '{ "setup-worktree": ["bun install"], }';
    const frinkPath = await writeFrinkFile(projectPath, content);

    await expect(
      updateWorktreeConfig(projectPath, { 'setup-worktree': ['bun ci'] }),
    ).rejects.toThrow("Frink couldn't read .frink/worktrees.json");
    expect(await readFile(frinkPath, 'utf-8')).toBe(content);
  });

  // A write that silently reports success is indistinguishable from one that never landed.
  it('rejects when the file cannot be written', async () => {
    const projectPath = await createTempProjectDir();
    await writeFile(join(projectPath, '.frink'), 'not a directory', 'utf-8');

    await expect(
      updateWorktreeConfig(projectPath, { 'setup-worktree': ['bun install'] }),
    ).rejects.toThrow();
  });
});

describe('executeWorktreeSetup', () => {
  it('runs the configured commands in the worktree', async () => {
    const projectPath = await createTempProjectDir();
    const worktreePath = await createTempProjectDir();
    await writeFrinkConfig(projectPath, { 'setup-worktree': ['echo hello > ran.txt'] });

    const result = await executeWorktreeSetup(worktreePath, projectPath);

    expect(result.success).toBe(true);
    expect(result.commandsRun).toBe(1);
    expect((await readFile(join(worktreePath, 'ran.txt'), 'utf-8')).trim()).toBe('hello');
  });

  // An unreadable config says why setup was skipped, but must not fail (and so roll back) the
  // worktree the way a failing setup command does.
  it('skips setup for an unreadable config, saying why, without failing', async () => {
    const projectPath = await createTempProjectDir();
    const worktreePath = await createTempProjectDir();
    await writeFrinkFile(projectPath, '{ "setup-worktree": "bun install" }');

    const result = await executeWorktreeSetup(worktreePath, projectPath);

    expect(result.success).toBe(true);
    expect(result.commandsRun).toBe(0);
    expect(result.output).toEqual([
      expect.stringContaining("Frink couldn't read .frink/worktrees.json"),
    ]);
  });

  it('reports failure when a command exits non-zero', async () => {
    const projectPath = await createTempProjectDir();
    const worktreePath = await createTempProjectDir();
    await writeFrinkConfig(projectPath, { 'setup-worktree': ['exit 3'] });

    const result = await executeWorktreeSetup(worktreePath, projectPath);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('exit 3');
  });

  it('skips remaining commands once the signal aborts', async () => {
    const projectPath = await createTempProjectDir();
    const worktreePath = await createTempProjectDir();
    await writeFrinkConfig(projectPath, { 'setup-worktree': ['echo one', 'echo two'] });

    const controller = new AbortController();
    controller.abort();
    const result = await executeWorktreeSetup(worktreePath, projectPath, {
      signal: controller.signal,
    });

    expect(result.commandsRun).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Cancelled before');
  });

  it('stops once the aggregate budget is exhausted', async () => {
    const projectPath = await createTempProjectDir();
    const worktreePath = await createTempProjectDir();
    await writeFrinkConfig(projectPath, { 'setup-worktree': ['sleep 0.2', 'echo never'] });

    const result = await executeWorktreeSetup(worktreePath, projectPath, { budgetMs: 100 });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('budget exhausted') || e.includes('sleep'))).toBe(
      true,
    );
    expect(result.output).not.toContain('$ echo never');
  });
});
