import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpToolDescriptor } from '../../mcp/tools-probe';

type Fetch = { ok: true; byTool: Map<string, McpToolDescriptor> } | { ok: false; reason: string };
type FetchSlot = { current: Fetch };
type ProbeCall = { pluginId: string; serverId: string };

const state = vi.hoisted(() => {
  const fetched: FetchSlot = { current: { ok: false, reason: 'unset' } };
  const calls: ProbeCall[] = [];
  return { fetched, calls };
});

// The descriptor probe opens a live MCP transport; the projection under test is pure.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('./schema-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./schema-cache')>()),
  fetchServerDescriptors: vi.fn(async (pluginId: string, serverId: string) => {
    state.calls.push({ pluginId, serverId });
    if (state.fetched.current.ok === false && state.fetched.current.reason === 'THROW') {
      throw new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
      );
    }
    if (state.fetched.current.ok === false && state.fetched.current.reason === 'HANG') {
      return new Promise<Fetch>(() => {});
    }
    return state.fetched.current;
  }),
}));

// Sentry is the developer-facing copy of the failure the user sees in plain words.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../sentry/init', () => ({
  captureMainMessage: vi.fn(),
  captureMainException: vi.fn(),
}));

import { listPluginServerTools } from './server-tools';

describe('listPluginServerTools', () => {
  beforeEach(() => {
    state.calls.length = 0;
  });

  it('projects each advertised tool to picker rows: hints as flags, schema as manifest inputs, never raw', async () => {
    const list: McpToolDescriptor = {
      name: 'error-tracking-list',
      title: 'List errors',
      description: 'Lists issues.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number' }, filters: { type: 'object' } },
        required: ['limit'],
      },
    };
    const wipe: McpToolDescriptor = { name: 'wipe', annotations: { destructiveHint: true } };
    state.fetched.current = {
      ok: true,
      byTool: new Map([
        [list.name, list],
        [wipe.name, wipe],
      ]),
    };
    const result = await listPluginServerTools('posthog');
    expect(result).toEqual({
      ok: true,
      tools: [
        {
          name: 'error-tracking-list',
          title: 'List errors',
          description: 'Lists issues.',
          readOnly: true,
          destructive: false,
          inputs: { limit: { type: 'number', required: true }, filters: { type: 'json' } },
          unsupportedFields: [],
        },
        { name: 'wipe', readOnly: false, destructive: true, inputs: {}, unsupportedFields: [] },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('inputSchema');
    expect(state.calls).toEqual([{ pluginId: 'posthog', serverId: 'posthog' }]);
  });

  it('turns a thrown credential read and a read that never settles into the typed failure', async () => {
    state.fetched.current = { ok: false, reason: 'THROW' };
    expect(await listPluginServerTools('posthog')).toEqual({
      ok: false,
      reason: "Frink couldn't read posthog's saved sign-in. Reconnect it in Settings → Plugins.",
    });

    vi.useFakeTimers();
    try {
      state.fetched.current = { ok: false, reason: 'HANG' };
      const pending = listPluginServerTools('posthog');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toEqual({
        ok: false,
        reason:
          "Reading posthog's tool list took too long — check its connection in Settings → Plugins.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the server failure typed, and refuses a plugin without a call-tool row', async () => {
    state.fetched.current = { ok: false, reason: 'posthog is not connected' };
    expect(await listPluginServerTools('posthog')).toEqual({
      ok: false,
      reason: 'posthog is not connected',
    });
    expect(await listPluginServerTools('slack')).toEqual({
      ok: false,
      reason: 'slack has no call-tool node.',
    });
  });
});
