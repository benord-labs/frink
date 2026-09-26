import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCodexSkillRootsRpcOutcomeForTests,
  recordCodexSkillRootsRpcOutcome,
} from '../../agent-runner/codex/skill-roots';
import { deliverPlugins } from './plugins';

const claudeCtx = { projectId: 'p', projectPath: '/p', provider: 'claude-code' as const };
const codexCtx = { projectId: 'p', projectPath: '/p', provider: 'codex' as const };

describe('deliverPlugins probe', () => {
  let tmpRoot: string;

  beforeEach(() => {
    _resetCodexSkillRootsRpcOutcomeForTests();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-plugins-probe-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    vi.stubEnv('FRINK_HOME', tmpRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function stageFixture(opts: { claudeProjection: boolean; codexSkills: boolean }): void {
    const pluginsRoot = path.join(tmpRoot, '.frink', 'plugins');
    fs.mkdirSync(pluginsRoot, { recursive: true });
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
    if (opts.claudeProjection) {
      fs.mkdirSync(path.join(pluginsRoot, 'projections', 'claude-code', 'slack', '1.0.0'), {
        recursive: true,
      });
    }
    if (opts.codexSkills) {
      const codexDir = path.join(pluginsRoot, 'projections', 'codex', 'slack', '1.0.0');
      fs.mkdirSync(path.join(codexDir, '.codex-plugin'), { recursive: true });
      fs.mkdirSync(path.join(codexDir, 'skills'), { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, '.codex-plugin', 'plugin.json'),
        JSON.stringify({ name: 'slack', skills: './skills/' }),
      );
    }
  }

  it('claude: reports staged projections, and a missing dir as delivery failure', async () => {
    stageFixture({ claudeProjection: true, codexSkills: false });
    const ok = await deliverPlugins({ mode: 'copy', ctx: claudeCtx });
    expect(ok.status).toBe('delivered');

    fs.rmSync(path.join(tmpRoot, '.frink', 'plugins', 'projections', 'claude-code'), {
      recursive: true,
    });
    const broken = await deliverPlugins({ mode: 'copy', ctx: claudeCtx });
    expect(broken.status).toBe('noop');
    expect(broken.detail).toMatch(/DELIVERY FAILURE/);
  });

  it('codex: staged roots with no session yet report as awaiting, not delivered', async () => {
    stageFixture({ claudeProjection: true, codexSkills: true });
    const result = await deliverPlugins({ mode: 'inject', ctx: codexCtx });
    expect(result.status).toBe('noop');
    expect(result.detail).toMatch(/awaiting first codex session/);
  });

  it('codex: reports failure when the RPC errored even though the dirs exist', async () => {
    stageFixture({ claudeProjection: true, codexSkills: true });
    recordCodexSkillRootsRpcOutcome({ ok: false, error: 'peer rejected' });
    const result = await deliverPlugins({ mode: 'inject', ctx: codexCtx });
    expect(result.status).toBe('noop');
    expect(result.detail).toMatch(/DELIVERY FAILURE — skills\/extraRoots\/set rejected/);
  });

  it('codex: delivered once the RPC succeeded, noop with nothing staged', async () => {
    stageFixture({ claudeProjection: true, codexSkills: true });
    recordCodexSkillRootsRpcOutcome({ ok: true });
    const delivered = await deliverPlugins({ mode: 'inject', ctx: codexCtx });
    expect(delivered.status).toBe('delivered');

    fs.rmSync(path.join(tmpRoot, '.frink'), { recursive: true, force: true });
    const empty = await deliverPlugins({ mode: 'inject', ctx: codexCtx });
    expect(empty.status).toBe('noop');
    expect(empty.detail).toBe('no codex skill roots staged');
  });
});
