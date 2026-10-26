import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sentry from '../sentry/init';
import {
  __resetStagedVsLoadedForTest,
  reportStagedNotLoaded,
  STAGED_VS_LOADED_SURFACE,
  skillFolders,
} from './staged-vs-loaded';

describe('reportStagedNotLoaded', () => {
  beforeEach(() => __resetStagedVsLoadedForTest());
  afterEach(() => vi.restoreAllMocks());

  it('stays quiet when everything staged loaded, or the provider did not report a category', () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const warn = vi.spyOn(log, 'warn');
    const staged = { skills: ['a'], plugins: ['p@m'] };
    reportStagedNotLoaded('claude', 'chat-1', staged, { skills: ['a', 'b'] });
    expect(capture).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('names what is missing, sorted, and groups it by runtime and category', () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const warn = vi.spyOn(log, 'warn');
    reportStagedNotLoaded(
      'claude',
      'chat-1',
      { agents: ['kept'], mcpServers: ['b', 'a'], skills: ['x'] },
      { agents: ['kept'], mcpServers: [], skills: [] },
    );
    const message = 'claude loaded less than Frink staged (mcpServers: a, b; skills: x)';
    expect(warn).toHaveBeenCalledWith(`[provider] ${message}`);
    expect(capture).toHaveBeenCalledWith(
      message,
      'warning',
      {
        surface: STAGED_VS_LOADED_SURFACE,
        runtime: 'claude',
        subChatId: 'chat-1',
        categories: 'mcpServers,skills',
      },
      [STAGED_VS_LOADED_SURFACE, 'claude', 'mcpServers', 'skills'],
    );
  });

  it('names ten missing items per category, then counts the rest', () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const skills = Array.from({ length: 12 }, (_, index) => `s${String(index).padStart(2, '0')}`);
    reportStagedNotLoaded('codex', 'chat-1', { skills }, { skills: [] });
    expect(capture.mock.calls[0]?.[0]).toBe(
      `codex loaded less than Frink staged (skills: ${skills.slice(0, 10).join(', ')} and 2 more)`,
    );
  });

  it('logs every session but sends a mismatch once per app run', () => {
    const capture = vi.spyOn(sentry, 'captureMainMessage');
    const warn = vi.spyOn(log, 'warn');
    const report = (subChatId: string) =>
      reportStagedNotLoaded('claude', subChatId, { skills: ['x'] }, { skills: [] });
    report('chat-1');
    report('chat-2');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(1);
    __resetStagedVsLoadedForTest();
    report('chat-3');
    expect(capture).toHaveBeenCalledTimes(2);
  });
});

describe('skillFolders', () => {
  let root: string;
  let skills: string;
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skill-folders-'));
    skills = path.join(root, 'skills');
    await fs.promises.mkdir(skills);
  });
  afterEach(() => fs.promises.rm(root, { recursive: true, force: true }));

  async function writeSkill(dir: string): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'SKILL.md'), '# A skill');
  }

  it('lists the folders that hold a SKILL.md', async () => {
    await writeSkill(path.join(skills, 'kept'));
    await fs.promises.mkdir(path.join(skills, 'no-skill-file'));
    await fs.promises.writeFile(path.join(skills, 'loose.md'), '');
    expect(await skillFolders(skills)).toEqual(['kept']);
  });

  it('has none under a missing root and rejects a root that is a file', async () => {
    expect(await skillFolders(path.join(root, 'missing'))).toEqual([]);
    const file = path.join(root, 'file');
    await fs.promises.writeFile(file, '');
    await expect(skillFolders(file)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'follows a linked skill folder and skips a broken link',
    async () => {
      const elsewhere = path.join(root, 'elsewhere');
      await writeSkill(elsewhere);
      await fs.promises.symlink(elsewhere, path.join(skills, 'linked'));
      await fs.promises.symlink(path.join(root, 'gone'), path.join(skills, 'broken'));
      expect(await skillFolders(skills)).toEqual(['linked']);
    },
  );
});
