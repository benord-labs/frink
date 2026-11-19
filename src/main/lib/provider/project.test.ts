import { describe, expect, it, vi } from 'vitest';
import { AI_PROVIDERS, type AiProviderId } from '../../../shared/lib/ai-providers';
import { NOTHING_DELIVERED } from '../../../shared/lib/ai-providers/capabilities';
import { project } from './project';

describe('project().probe', () => {
  it.each<AiProviderId>(['claude-code', 'codex'])(
    'reports %s supported, with its row',
    (provider) => {
      const result = project('proj-1', '/tmp/proj', provider).probe();
      expect(result.supported).toBe(true);
      expect(result.descriptor).toBe(AI_PROVIDERS[provider].capabilities.delivery);
      expect(result.reason).toBeUndefined();
    },
  );

  it('says why a provider whose row delivers nothing is unsupported', () => {
    expect(project('proj-1', '/tmp/proj', 'cursor').probe()).toEqual({
      supported: false,
      descriptor: NOTHING_DELIVERED,
      reason: 'Frink delivers nothing to Cursor yet.',
    });
  });
});

describe('project().deliver dispatch (async, registry-routed)', () => {
  const p = project('proj-1', '/tmp/proj', 'claude-code');

  it('routes a deliver category off its descriptor mode to its handler stub', async () => {
    // claude-code mcp = inject; skills = copy. Each → its PCH-x handler.
    expect(await p.deliver('mcp')).toMatchObject({
      category: 'mcp',
      mode: 'inject',
      status: 'noop',
    });
    expect(await p.deliver('skills')).toMatchObject({
      category: 'skills',
      mode: 'copy',
    });
  });

  it('leaves hooks to the launch, which hands them to the provider itself', async () => {
    expect(await p.deliver('hooks')).toEqual({
      category: 'hooks',
      mode: 'file',
      status: 'noop',
      detail: 'handed over at launch',
    });
  });

  it('probes plugins delivery against the staged store (empty home → nothing staged)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-plugins-probe-'));
    const spy = vi.spyOn(os.default ?? os, 'homedir').mockReturnValue(tmp);
    try {
      expect(await p.deliver('plugins')).toMatchObject({
        mode: 'copy',
        status: 'noop',
        detail: 'no vendor plugins staged',
      });
    } finally {
      spy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('defers a rule-only category (no deliver handler) to enforce()', async () => {
    // claude-code allowlist = enforce; no deliver handler registered → points at enforce().
    expect((await p.deliver('allowlist')).detail).toMatch(/use enforce/i);
  });
});

describe('project().enforce dispatch (async, registry-routed)', () => {
  it('routes the enforce mode for a hard-gate provider', async () => {
    const p = project('proj-1', '/tmp/proj', 'claude-code');
    expect(await p.enforce('allowlist')).toMatchObject({
      category: 'allowlist',
      mode: 'enforce',
      status: 'noop',
    });
  });

  it('defers a deliver-only category (no enforce handler) to deliver()', async () => {
    const p = project('proj-1', '/tmp/proj', 'claude-code');
    // mcp = inject (a delivery mode); no enforce handler registered → points at deliver().
    expect((await p.enforce('mcp')).detail).toMatch(/use deliver/i);
  });
});
