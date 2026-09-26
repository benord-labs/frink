import { describe, expect, it } from 'vitest';
import { builtinRuntimeSupport, withStagedDelivery } from './plugin-runtime-support';
import type { PluginPackageContents } from './plugins';

const base: PluginPackageContents = {
  mcpServers: [],
  skills: [],
  nativeExtensions: [],
  triggers: [],
  actions: [],
};

const NOTHING = {
  skills: false,
  commands: false,
  mcp: false,
  flowTriggers: false,
  flowActions: false,
};
const TRIGGERS_ONLY = {
  skills: false,
  commands: false,
  mcp: false,
  flowTriggers: true,
  flowActions: false,
};

const trigger = {
  id: 'example.task_assigned',
  label: 'Task assigned to me',
  filterFieldIds: [],
  source: { type: 'provider_event', providerId: 'example', eventId: 'task_assigned' },
} as const;
const MCP_ONLY = {
  skills: false,
  commands: false,
  mcp: true,
  flowTriggers: false,
  flowActions: false,
};

const vendorHttp = {
  id: 'slack',
  label: 'Slack (vendor)',
  ownership: 'provider_native',
  schemaSource: 'mcp_tools_list',
  transport: {
    type: 'http',
    url: 'https://mcp.slack.com/mcp',
    auth: { kind: 'static_client', clientId: 'x', callbackPort: 3118 },
  },
  connectionBinding: { type: 'none' },
} as const;

const stdio = {
  id: 'shortcut',
  label: 'Shortcut',
  ownership: 'provider_native',
  schemaSource: 'mcp_tools_list',
  transport: { type: 'stdio', command: 'mcp-server-shortcut' },
  connectionBinding: { type: 'none' },
} as const;

describe('withStagedDelivery', () => {
  const codexNative = {
    id: 'slack.codex-plugin',
    kind: 'runtime_native',
    runtime: 'codex',
    path: '.codex-plugin/plugin.json',
  } as const;
  const declared = builtinRuntimeSupport(
    { ...base, mcpServers: [vendorHttp], nativeExtensions: [codexNative] },
    true,
  );

  it('replaces the marker inference with what the staged payload really ships', () => {
    const staged = withStagedDelivery(declared, { skills: ['a'], commands: [] });
    expect(staged['claude-code'].delivers).toEqual({
      skills: true,
      commands: false,
      mcp: true,
      flowTriggers: false,
      flowActions: false,
    });
    expect(staged.codex.delivers).toEqual({
      skills: true,
      commands: false,
      mcp: true,
      flowTriggers: false,
      flowActions: false,
    });
  });

  it('delivers staged portable skills without a Codex-native wrapper', () => {
    const catalogOnly = builtinRuntimeSupport({ ...base, mcpServers: [vendorHttp] }, true);
    const staged = withStagedDelivery(catalogOnly, { skills: ['a'], commands: [] });
    expect(staged.codex.delivers).toEqual({
      skills: true,
      commands: false,
      mcp: true,
      flowTriggers: false,
      flowActions: false,
    });
    expect(staged['claude-code'].delivers).toEqual({
      skills: true,
      commands: false,
      mcp: true,
      flowTriggers: false,
      flowActions: false,
    });
  });

  it('grants both runtimes the package commands, and leaves an unsupported runtime untouched', () => {
    const staged = withStagedDelivery(declared, { skills: [], commands: ['x'] });
    expect(staged.codex.delivers).toEqual({
      skills: false,
      commands: true,
      mcp: true,
      flowTriggers: false,
      flowActions: false,
    });
    expect(staged['claude-code'].delivers).toEqual({
      skills: false,
      commands: true,
      mcp: true,
      flowTriggers: false,
      flowActions: false,
    });
    const none = builtinRuntimeSupport(base, true);
    expect(withStagedDelivery(none, { skills: ['a'], commands: ['x'] })).toEqual(none);
  });
});

describe('builtinRuntimeSupport (transport-aware, sc-1831)', () => {
  it('reports a vendor http MCP as flag-gated while vendorClaudePlugins is off', () => {
    const vendorPackage = {
      id: 'slack.codex-plugin',
      kind: 'runtime_native',
      runtime: 'codex',
      path: '.codex-plugin/plugin.json',
    } as const;
    const m = builtinRuntimeSupport(
      { ...base, mcpServers: [vendorHttp], nativeExtensions: [vendorPackage] },
      false,
    );
    expect(m['claude-code'].status).toBe('unsupported');
    expect(m['claude-code'].reason).toMatch(/flag-gated/);
  });

  it('reports a vendor http MCP as supported once the flag is on', () => {
    const vendorPackage = {
      id: 'slack.codex-plugin',
      kind: 'runtime_native',
      runtime: 'codex',
      path: '.codex-plugin/plugin.json',
    } as const;
    const m = builtinRuntimeSupport(
      { ...base, mcpServers: [vendorHttp], nativeExtensions: [vendorPackage] },
      true,
    );
    expect(m['claude-code'].status).toBe('supported');
  });

  it('stays honest with no agent contents: neither runtime gets anything', () => {
    const m = builtinRuntimeSupport(base, true);
    expect(m['claude-code']).toEqual({
      status: 'unsupported',
      delivers: NOTHING,
      reason: expect.any(String),
    });
    expect(m.codex).toEqual({
      status: 'unsupported',
      delivers: NOTHING,
      reason: expect.any(String),
    });
  });

  it('lists only runtimes a plugin can reach — no row for a runtime that delivers nothing anywhere', () => {
    expect(Object.keys(builtinRuntimeSupport(base, true)).sort()).toEqual(['claude-code', 'codex']);
  });

  it('draws native_only as the facts it stands for: the package skills, never an MCP server', () => {
    const withSkills = builtinRuntimeSupport(
      { ...base, skills: [{ id: 's', name: 'S', description: 'd', path: 'skills/s' }] },
      false,
    );
    expect(withSkills['claude-code']).toMatchObject({
      status: 'native_only',
      delivers: {
        skills: true,
        commands: false,
        mcp: false,
        flowTriggers: false,
        flowActions: false,
      },
    });
  });

  describe('codex portable package delivery', () => {
    const codexNative = {
      id: 'slack.codex-plugin',
      kind: 'runtime_native',
      runtime: 'codex',
      path: '.codex-plugin/plugin.json',
    } as const;

    it('supports a package with a native Codex declaration', () => {
      const m = builtinRuntimeSupport(
        { ...base, mcpServers: [vendorHttp], nativeExtensions: [codexNative] },
        true,
      );
      // The marker ships skills, Frink delivers the MCP server and expands the package's commands.
      expect(m.codex).toEqual({
        status: 'supported',
        delivers: {
          skills: true,
          commands: true,
          mcp: true,
          flowTriggers: false,
          flowActions: false,
        },
      });
    });

    it('supports both runtimes for a catalog server Frink can authenticate, MCP only', () => {
      for (const kind of ['static_client', 'frink_client'] as const) {
        const auth =
          kind === 'static_client' ? { kind, clientId: 'x', callbackPort: 3118 } : { kind };
        const server = { ...vendorHttp, transport: { ...vendorHttp.transport, auth } } as const;
        const m = builtinRuntimeSupport({ ...base, mcpServers: [server] }, true);
        expect(m.codex).toEqual({ status: 'supported', delivers: MCP_ONLY });
        expect(m['claude-code']).toEqual({ status: 'supported', delivers: MCP_ONLY });
      }
    });

    it('delivers a user_token server: the token grant stores the bearer Frink forwards', () => {
      const server = {
        ...vendorHttp,
        transport: {
          ...vendorHttp.transport,
          auth: {
            kind: 'user_token',
            setupUrl: 'https://x.test',
            validation: { url: 'https://x.test/me' },
          },
        },
      } as const;
      const m = builtinRuntimeSupport({ ...base, mcpServers: [server] }, true);
      expect(m['claude-code'].status).toBe('supported');
    });

    it('treats a catalog stdio server as listed only, never native_only', () => {
      const m = builtinRuntimeSupport({ ...base, mcpServers: [stdio] }, true);
      expect(m['claude-code']).toEqual({
        status: 'unsupported',
        delivers: NOTHING,
        reason: expect.stringMatching(/can't be connected yet/),
      });
      expect(m.codex.status).toBe('unsupported');
    });

    it('states the same vendor-package facts for both runtimes; only skills stay marker-gated', () => {
      const m = builtinRuntimeSupport(
        { ...base, mcpServers: [vendorHttp], nativeExtensions: [codexNative] },
        true,
      );
      expect(m['claude-code']).toEqual({
        status: 'supported',
        delivers: {
          skills: true,
          commands: true,
          mcp: true,
          flowTriggers: false,
          flowActions: false,
        },
      });
      expect(m.codex).toEqual({
        status: 'supported',
        delivers: {
          skills: true,
          commands: true,
          mcp: true,
          flowTriggers: false,
          flowActions: false,
        },
      });
      // A delivering runtime carries no prose for the page to paraphrase.
      expect(m['claude-code'].reason).toBeUndefined();
      expect(m.codex.reason).toBeUndefined();
    });

    it('treats a pending http server as listed only, in both runtimes', () => {
      const pending = {
        ...vendorHttp,
        transport: { ...vendorHttp.transport, auth: { kind: 'pending' } },
      } as const;
      const m = builtinRuntimeSupport({ ...base, mcpServers: [pending] }, true);
      expect(m.codex).toEqual({
        status: 'unsupported',
        delivers: NOTHING,
        reason: expect.stringMatching(/can't be connected yet/),
      });
      expect(m['claude-code']).toEqual({
        status: 'unsupported',
        delivers: NOTHING,
        reason: expect.stringMatching(/can't be connected yet/),
      });
    });

    it('never claims codex for a plugin with no deliverable server and no package', () => {
      const m = builtinRuntimeSupport({ ...base, mcpServers: [stdio] }, true);
      expect(m.codex.status).toBe('unsupported');
      expect(m.codex.reason).toMatch(/can't be connected yet/);
    });

    it('stays flag-gated like claude while vendorClaudePlugins is off', () => {
      const m = builtinRuntimeSupport({ ...base, nativeExtensions: [codexNative] }, false);
      expect(m.codex.status).toBe('unsupported');
      expect(m.codex.reason).toMatch(/flag-gated/);
    });

    it('a codex-only marker does not count as claude-native contents', () => {
      const m = builtinRuntimeSupport({ ...base, nativeExtensions: [codexNative] }, true);
      expect(m['claude-code'].status).toBe('unsupported');
    });
  });

  describe('the Flow capability cells', () => {
    const codexMarker = {
      id: 'slack.codex-plugin',
      kind: 'runtime_native',
      runtime: 'codex',
      path: '.codex-plugin/plugin.json',
    } as const;

    it('states a trigger-only plugin on both rows, unsupported reason intact', () => {
      // Trigger-only package: no chat capability, but usable in a Flow.
      const m = builtinRuntimeSupport({ ...base, triggers: [trigger] }, true);
      expect(m['claude-code']).toEqual({
        status: 'unsupported',
        delivers: TRIGGERS_ONLY,
        reason: expect.stringMatching(/no agent capability package/),
      });
      expect(m.codex).toEqual({
        status: 'unsupported',
        delivers: TRIGGERS_ONLY,
        reason: expect.stringMatching(/no agent capability package/),
      });
    });

    it('counts a curated action on its own, with no trigger', () => {
      const action = {
        id: 'example.create_task',
        label: 'Create task',
        schemaSource: 'frink_versioned',
        mutates: true,
        inputs: {},
        source: { type: 'deterministic_flow', operationId: 'create_task', schemaVersion: 'v1' },
      } as const;
      const m = builtinRuntimeSupport({ ...base, actions: [action] }, true);
      expect(m['claude-code'].delivers).toMatchObject({ flowTriggers: false, flowActions: true });
      expect(m.codex.delivers).toMatchObject({ flowTriggers: false, flowActions: true });
    });

    it('stays false when a plugin ships neither trigger nor action', () => {
      const m = builtinRuntimeSupport({ ...base, mcpServers: [vendorHttp] }, true);
      expect(m['claude-code'].delivers).toMatchObject({ flowTriggers: false, flowActions: false });
      expect(m.codex.delivers).toMatchObject({ flowTriggers: false, flowActions: false });
    });

    it('survives staging, which can add skills and commands but never a Flow block', () => {
      const declaredFlows = builtinRuntimeSupport(
        { ...base, mcpServers: [vendorHttp], nativeExtensions: [codexMarker], triggers: [trigger] },
        true,
      );
      const staged = withStagedDelivery(declaredFlows, { skills: ['a'], commands: ['b'] });
      expect(staged['claude-code'].delivers).toMatchObject({
        flowTriggers: true,
        flowActions: false,
      });
      expect(staged.codex.delivers).toMatchObject({ flowTriggers: true, flowActions: false });
    });
  });
});
