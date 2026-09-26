import { describe, expect, it, vi } from 'vitest';
import { CAPABILITY_MAP, getCapabilityDescriptor } from './capabilities';
import { project } from './project';
import type { ProviderType } from './types';

describe('getCapabilityDescriptor', () => {
  it('returns the verified row for known providers', () => {
    expect(getCapabilityDescriptor('claude-code')).toBe(CAPABILITY_MAP['claude-code']);
    expect(getCapabilityDescriptor('cursor')).toBe(CAPABILITY_MAP.cursor);
  });

  it('seeds the verified claude-code + cursor modes exactly', () => {
    expect(getCapabilityDescriptor('claude-code')).toEqual({
      mcp: 'inject',
      skills: 'copy',
      commands: 'copy',
      agentBrain: 'inject',
      allowlist: 'enforce',
      hooks: 'file',
      // Vendor plugins reach chat sessions as a hook-stripped copy staged by
      // session-config-dir.ts (provider-config-canonical-home 2026-08-24).
      plugins: 'copy',
    });
    // Cursor differs on allowlist (no host veto → advisory) and agentBrain
    // (CLI consumes agent FILES — no in-memory channel → copy).
    expect(getCapabilityDescriptor('cursor').allowlist).toBe('advisory');
    expect(getCapabilityDescriptor('cursor').agentBrain).toBe('copy');
  });

  it('seeds the verified codex modes for the app-server invocation', () => {
    // codex app-server: mcp injected via --config; skills/agentBrain are files; commands `none`
    // (no command channel, sc-2800); allowlist ENFORCED via the JSON-RPC approval callback;
    // vendor-plugin skills injected per-startup via skills/extraRoots/set (sc-1731).
    expect(getCapabilityDescriptor('codex')).toEqual({
      mcp: 'inject',
      skills: 'copy',
      commands: 'none',
      agentBrain: 'copy',
      allowlist: 'enforce',
      hooks: 'none',
      plugins: 'inject',
    });
  });

  it('leaves still-unverified providers all-none', () => {
    // SAFETY: literal provider ids narrowed for iteration; both are members
    // of ProviderType and the loop exercises their real descriptor rows.
    for (const p of ['gemini', 'opencode'] as ProviderType[]) {
      const d = getCapabilityDescriptor(p);
      expect(Object.values(d).every((m) => m === 'none')).toBe(true);
    }
  });

  it('fails safe (all-none) for an unknown / unmapped provider', () => {
    // SAFETY: deliberately out-of-union value — the subject under test IS the
    // unknown-provider fail-safe, which only a forced cast can reach.
    const unknown = 'totally-unknown' as ProviderType;
    const d = getCapabilityDescriptor(unknown);
    // A forgotten map row must bridge NOTHING, not silently behave like claude-code.
    expect(Object.values(d).every((m) => m === 'none')).toBe(true);
  });
});

describe('project().probe', () => {
  it('reports supported + the right descriptor for a verified provider', () => {
    const p = project('proj-1', '/tmp/proj', 'claude-code');
    const result = p.probe();
    expect(result.supported).toBe(true);
    expect(result.descriptor).toBe(CAPABILITY_MAP['claude-code']);
    expect(result.reason).toBeUndefined();
  });

  it('reports supported for the now-verified codex provider', () => {
    const p = project('proj-1', '/tmp/proj', 'codex');
    const result = p.probe();
    expect(result.supported).toBe(true);
    expect(result.descriptor).toBe(CAPABILITY_MAP.codex);
    expect(result.reason).toBeUndefined();
  });

  it('reports unsupported + a reason for a still-unverified provider', () => {
    const p = project('proj-1', '/tmp/proj', 'gemini');
    const result = p.probe();
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/not yet verified/i);
    // Descriptor is still returned (the all-none placeholder) so callers never crash.
    expect(result.descriptor).toBe(CAPABILITY_MAP.gemini);
  });

  it('fails safe (unsupported + all-none descriptor) for an unknown provider', () => {
    // SAFETY: deliberately out-of-union value — exercises the same fail-safe.
    const p = project('proj-1', '/tmp/proj', 'mystery' as ProviderType);
    const result = p.probe();
    expect(result.supported).toBe(false);
    expect(Object.values(result.descriptor).every((m) => m === 'none')).toBe(true);
    expect(result.reason).toBeDefined();
  });
});

describe('project().deliver dispatch (async, registry-routed)', () => {
  const p = project('proj-1', '/tmp/proj', 'claude-code');

  it('routes a deliver category off its descriptor mode to its handler stub', async () => {
    // claude-code mcp = inject; skills = copy; hooks = file. Each → its PCH-x stub.
    expect(await p.deliver('mcp')).toMatchObject({
      category: 'mcp',
      mode: 'inject',
      status: 'noop',
    });
    expect(await p.deliver('skills')).toMatchObject({
      category: 'skills',
      mode: 'copy',
    });
    expect(await p.deliver('hooks')).toMatchObject({
      category: 'hooks',
      mode: 'file',
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

  it('routes the advisory mode for a no-veto provider', async () => {
    const p = project('proj-1', '/tmp/proj', 'cursor');
    expect(await p.enforce('allowlist')).toMatchObject({
      mode: 'advisory',
      status: 'noop',
    });
  });

  it('defers a deliver-only category (no enforce handler) to deliver()', async () => {
    const p = project('proj-1', '/tmp/proj', 'claude-code');
    // mcp = inject (a delivery mode); no enforce handler registered → points at deliver().
    expect((await p.enforce('mcp')).detail).toMatch(/use deliver/i);
  });
});
