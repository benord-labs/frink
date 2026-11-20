import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverSkills } from './skills';
import { mockHome } from './test-mock-home';

vi.mock('node:os', async (importOriginal) =>
  (await import('./test-mock-home')).osModuleWithMockHome(importOriginal),
);
vi.mock('electron-log', async () => (await import('./test-mock-home')).electronLogMock());

const SKILL = '---\nname: x\ndescription: y\n---\nbody\n';
const ctx = { projectId: 'p', projectPath: '/p', provider: 'claude-code' as const };

async function mkSkill(dir: string, extra?: Record<string, string>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL);
  for (const [name, body] of Object.entries(extra ?? {})) {
    await fs.writeFile(path.join(dir, name), body);
  }
}

describe('deliverSkills (PCH-2)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pch2-handler-'));
    mockHome.value = tmp;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('projects a Cursor-folder skill to the universal targets and leaves the original alone', async () => {
    const own = path.join(tmp, '.cursor', 'skills', 'mine');
    await mkSkill(own);
    const res = await deliverSkills({ mode: 'copy', ctx });
    expect(res.status).toBe('delivered');
    expect(res.detail).toContain('1');
    expect(existsSync(path.join(tmp, '.claude', 'skills', 'mine', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(tmp, '.agents', 'skills', 'mine', 'SKILL.md'))).toBe(true);
    expect(await fs.readdir(own)).toEqual(['SKILL.md']);
  });

  it('excludes frink-shipped (.baseline.json) and our own projections (.frink-projected)', async () => {
    await mkSkill(path.join(tmp, '.claude', 'skills', 'frink-flows'), {
      '.baseline.json': '{}',
    });
    await mkSkill(path.join(tmp, '.agents', 'skills', 'already'), {
      '.frink-projected': '{"hash":"abc"}',
    });
    const res = await deliverSkills({ mode: 'copy', ctx });
    expect(res.detail).toContain('0');
  });

  it('dedups a same-name skill: the ~/.agents copy wins over the Cursor folder', async () => {
    await mkSkill(path.join(tmp, '.cursor', 'skills', 'dup'), { 'ref.md': 'cursor\n' });
    await mkSkill(path.join(tmp, '.agents', 'skills', 'dup'), { 'ref.md': 'agents\n' });
    const res = await deliverSkills({ mode: 'copy', ctx });
    expect(res.detail).toContain('1');
    const claudeRef = path.join(tmp, '.claude', 'skills', 'dup', 'ref.md');
    expect(await fs.readFile(claudeRef, 'utf8')).toBe('agents\n');
    expect(await fs.readFile(path.join(tmp, '.cursor', 'skills', 'dup', 'ref.md'), 'utf8')).toBe(
      'cursor\n',
    );
  });
});
