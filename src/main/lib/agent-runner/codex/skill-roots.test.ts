import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCodexSkillRootsBinding,
  getCodexSkillRootsRpcOutcome,
  recordCodexSkillRootsRpcOutcome,
} from './skill-roots';

describe('buildCodexSkillRootsBinding', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-skill-roots-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    vi.stubEnv('FRINK_HOME', tmpRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function stageFixturePlugin(): string {
    const pluginsRoot = path.join(tmpRoot, '.frink', 'plugins');
    const projection = path.join(pluginsRoot, 'projections', 'codex', 'slack', '1.0.0');
    fs.mkdirSync(path.join(projection, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(projection, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(projection, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'slack', skills: './skills/' }),
    );
    fs.writeFileSync(
      path.join(pluginsRoot, 'staged.json'),
      JSON.stringify({
        plugins: [
          {
            id: 'slack@mkt',
            marketplace: 'mkt',
            name: 'slack',
            version: '1.0.0',
            gitCommitSha: 'abc',
            sourceRepo: 'o/r',
            installedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    return path.join(projection, 'skills');
  }

  it('is empty (but still versioned) while the vendor-plugins flag is off', () => {
    stageFixturePlugin();
    const off = buildCodexSkillRootsBinding(false);
    expect(off.extraSkillRoots).toEqual([]);
    expect(off.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes revision when the staged roots change, so warm servers are evicted', () => {
    const empty = buildCodexSkillRootsBinding(true);
    expect(empty.extraSkillRoots).toEqual([]);

    const skillsDir = stageFixturePlugin();
    const staged = buildCodexSkillRootsBinding(true);
    expect(staged.extraSkillRoots).toEqual([skillsDir]);
    expect(staged.revision).not.toBe(empty.revision);

    // Same staged state → same revision: no spurious server eviction.
    expect(buildCodexSkillRootsBinding(true).revision).toBe(staged.revision);
  });
});

describe('codex skill-roots RPC outcome record', () => {
  it('round-trips the last delivery outcome for the plugins probe', () => {
    recordCodexSkillRootsRpcOutcome({ ok: false, error: 'boom' });
    expect(getCodexSkillRootsRpcOutcome()).toEqual({ ok: false, error: 'boom' });
    recordCodexSkillRootsRpcOutcome({ ok: true });
    expect(getCodexSkillRootsRpcOutcome()).toEqual({ ok: true });
  });
});
