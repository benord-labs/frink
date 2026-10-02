import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as discovery from '../../custom-nodes/discovery';
import type { PluginNodeManifest } from '../../integrations/plugin-node-derivation';
import { customNodesRouter } from './custom-nodes';

type DerivedNodesSlot = { nodes: PluginNodeManifest[] };

/** Integration nodes are derived from connection state, so the router's list is whatever this holds. */
const derivedPluginNodes = vi.hoisted((): DerivedNodesSlot => ({ nodes: [] }));

// Derivation reads sqlite and the MCP config; the router only forwards what it returns.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../integrations/plugin-node-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../integrations/plugin-node-derivation')>()),
  listPluginNodes: () => derivedPluginNodes.nodes,
}));

const electronLogMocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

const removeLocalCustomNodeFolderMock = vi.fn();
const clearCredentialsForNodeMock = vi.fn();
const runCustomNodeScriptMock = vi.fn();

vi.mock('../../custom-nodes/discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../custom-nodes/discovery')>();
  return {
    ...actual,
    removeLocalCustomNodeFolder: (...args: unknown[]) => removeLocalCustomNodeFolderMock(...args),
  };
});

vi.mock('../../custom-nodes/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../custom-nodes/credentials')>();
  return {
    ...actual,
    clearCredentialsForNode: (...args: unknown[]) => clearCredentialsForNodeMock(...args),
  };
});

vi.mock('../../custom-nodes/script-runner', () => ({
  runCustomNodeScript: (...args: unknown[]) => runCustomNodeScriptMock(...args),
}));

vi.mock('electron-log', () => ({
  default: electronLogMocks,
}));

const listPluginServerToolsMock = vi.hoisted(() => vi.fn());
// The lookup opens a live MCP transport; the router only forwards its input.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../integrations/plugin-node-derivation/server-tools', () => ({
  listPluginServerTools: listPluginServerToolsMock,
}));

describe('customNodesRouter', () => {
  beforeEach(() => {
    removeLocalCustomNodeFolderMock.mockReset();
    removeLocalCustomNodeFolderMock.mockResolvedValue({ ok: true, removed: true });
    clearCredentialsForNodeMock.mockReset();
    runCustomNodeScriptMock.mockReset();
    runCustomNodeScriptMock.mockResolvedValue({
      stdout: '[]',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
    electronLogMocks.warn.mockReset();
    electronLogMocks.error.mockReset();
    derivedPluginNodes.nodes = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('preserves opaque field keys through the real list, discovery, and health procedure middleware', async () => {
    const inputs = {
      site_id: { type: 'string', required: true },
      siteId: { type: 'string', description: 'A different vendor field' },
      'page-name': { type: 'string' },
      request: {
        type: 'json',
        default: { collection_id: 'example', 'field-filter': { localeId: 'en' } },
      },
    };
    const manifest: discovery.CustomNodeManifest = {
      name: 'opaque-fields',
      displayName: 'Opaque fields',
      description: '',
      version: '1',
      entrypoint: 'run.js',
      timeout: 60,
      inputs,
      outputs: { page_id: { type: 'string' }, 'page-name': { type: 'string' } },
      credentials: { api_key: { envVar: 'API_KEY' } },
      nodePath: '/tmp/opaque-fields',
    };
    const spy = vi
      .spyOn(discovery, 'discoverCustomNodes')
      .mockReturnValue({ valid: [manifest], errors: [], manifestWarnings: [] });
    try {
      const caller = customNodesRouter.createCaller({ getWindow: () => null });
      const rows = await caller.list();
      expect(rows[0]).toMatchObject({
        displayName: 'Opaque fields',
        nodePath: '/tmp/opaque-fields',
        inputs,
        outputs: manifest.outputs,
        createdAt: expect.any(String),
      });
      expect((await caller.discoverLocal()).valid[0]).toEqual(manifest);
      expect(await caller.health({ nodeName: manifest.name })).toMatchObject({
        summary: { valid: true, warningCount: 0, errorCount: 0 },
        manifest,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves live plugin schema dictionary keys and metadata through the real procedure middleware', async () => {
    const result = {
      ok: true,
      tools: [
        {
          name: 'get_site',
          readOnly: true,
          destructive: false,
          inputs: {
            site_id: { type: 'string' },
            siteId: { type: 'string' },
            'page-name': { type: 'string' },
          },
          unsupportedFields: ['raw_body'],
        },
      ],
    };
    listPluginServerToolsMock.mockResolvedValueOnce(result);
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    expect(await caller.pluginServerTools({ pluginId: 'webflow' })).toEqual(result);
  });

  it('list maps local manifests to the cloud DTO shape', async () => {
    const manifest = {
      name: 'my-node',
      displayName: 'My Node',
      description: '',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: {},
      outputs: {},
      icon: undefined,
      nodePath: '/Users/x/.frink/nodes/my-node',
    } as unknown as discovery.CustomNodeManifest;
    const spy = vi.spyOn(discovery, 'discoverCustomNodes').mockReturnValueOnce({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    const rows = await caller.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'local:my-node',
      name: 'my-node',
      displayName: 'My Node',
      nodePath: '/Users/x/.frink/nodes/my-node',
    });
    // Nothing verifies a local manifest, so the row must not claim it was.
    expect(rows[0]).not.toHaveProperty('verified');
    expect(spy).toHaveBeenCalledWith(discovery.CUSTOM_NODES_DIR);
    spy.mockRestore();
  });

  it('list does not forward a trust claim a manifest makes about itself', async () => {
    // A third-party manifest.json in ~/.frink/nodes can carry any top-level key; a self-declared
    // `verified` must not reach the renderer as if Frink had checked it.
    const manifest = {
      name: 'self-vouching',
      displayName: 'Self Vouching',
      description: '',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: {},
      outputs: {},
      nodePath: '/Users/x/.frink/nodes/self-vouching',
      verified: true,
    } as unknown as discovery.CustomNodeManifest;
    const spy = vi.spyOn(discovery, 'discoverCustomNodes').mockReturnValueOnce({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    const rows = await caller.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'local:self-vouching', name: 'self-vouching' });
    expect(rows[0]).not.toHaveProperty('verified');
    spy.mockRestore();
  });

  it('list includes derived plugin nodes with their owning plugin id', async () => {
    // The palette's Integrations category, the health badge, and the config
    // panel all resolve node types from this list — dropping the derived nodes
    // made every plugin node invisible to the flow editor.
    derivedPluginNodes.nodes = [
      {
        name: 'slack_send_message',
        displayName: 'Send Slack message',
        description: 'derived',
        version: '1',
        timeout: 60,
        kind: 'plugin_operation',
        owner: { pluginId: 'slack', actionId: 'slack.send_message' },
        source: {
          type: 'deterministic_flow',
          operationId: 'slack.send_message',
          schemaVersion: '1',
        },
        inputs: {},
        unsupportedFields: ['blocks'],
      },
    ];
    const spy = vi.spyOn(discovery, 'discoverCustomNodes').mockReturnValueOnce({
      valid: [],
      manifestWarnings: [],
      errors: [],
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    const rows = await caller.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'local:slack_send_message',
      name: 'slack_send_message',
      pluginId: 'slack',
      // A derived node has nothing on disk: no entrypoint to run, no folder to open.
      entrypoint: '',
      nodePath: '',
      unsupportedFields: ['blocks'],
    });
    expect(rows[0]).not.toHaveProperty('verified');
    spy.mockRestore();
  });

  it('pluginServerTools hands the plugin to the picker lookup', async () => {
    listPluginServerToolsMock.mockResolvedValue({ ok: false, reason: 'posthog is not connected' });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    expect(await caller.pluginServerTools({ pluginId: 'posthog' })).toEqual({
      ok: false,
      reason: 'posthog is not connected',
    });
    await caller.pluginServerTools({ pluginId: 'shortcut' });
    expect(listPluginServerToolsMock.mock.calls).toEqual([['posthog'], ['shortcut']]);
  });

  it('list returns empty array when no local manifests exist', async () => {
    const spy = vi.spyOn(discovery, 'discoverCustomNodes').mockReturnValueOnce({
      valid: [],
      manifestWarnings: [],
      errors: [],
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.list()).resolves.toEqual([]);
    spy.mockRestore();
  });

  it('sync returns counts derived from local discovery (no cloud)', async () => {
    const spy = vi.spyOn(discovery, 'discoverCustomNodes').mockReturnValueOnce({
      valid: [{ name: 'a' } as discovery.CustomNodeManifest],
      manifestWarnings: [{ name: 'a', warnings: ['w'] }],
      errors: [{ dir: 'bad', error: 'x' }],
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.sync()).resolves.toEqual({ success: true, synced: 1, errors: 1 });
    spy.mockRestore();
  });

  it('delete removes the local folder and clears credentials', async () => {
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.delete({ name: 'my-node' })).resolves.toEqual({ success: true });
    expect(removeLocalCustomNodeFolderMock).toHaveBeenCalledWith('my-node');
    expect(clearCredentialsForNodeMock).toHaveBeenCalledWith('my-node');
  });

  it('delete throws NOT_FOUND when local folder removal fails', async () => {
    removeLocalCustomNodeFolderMock.mockResolvedValueOnce({
      ok: false,
      error: 'Refusing to delete outside nodes directory',
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.delete({ name: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Custom node "missing" not found: Refusing to delete outside nodes directory',
    });
    expect(clearCredentialsForNodeMock).not.toHaveBeenCalled();
  });

  it('delete throws CONFLICT when another node change owns the install reservation', async () => {
    removeLocalCustomNodeFolderMock.mockResolvedValueOnce({
      ok: false,
      error: 'Another custom node change is in progress; retry after it finishes',
      busy: true,
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });

    await expect(caller.delete({ name: 'my-node' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Another custom node change is in progress; retry after it finishes',
    });
    expect(clearCredentialsForNodeMock).not.toHaveBeenCalled();
  });

  it('delete returns success when clearCredentialsForNode throws', async () => {
    clearCredentialsForNodeMock.mockImplementationOnce(() => {
      throw new Error('sqlite locked');
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.delete({ name: 'my-node' })).resolves.toEqual({ success: true });
    expect(electronLogMocks.warn).toHaveBeenCalledWith(
      '[customNodes.delete] failed to clear credentials',
      expect.any(Error),
    );
    expect(removeLocalCustomNodeFolderMock).toHaveBeenCalledWith('my-node');
  });

  it('health returns global summary from discoverCustomNodes', async () => {
    const spy = vi.spyOn(discovery, 'discoverCustomNodes').mockReturnValueOnce({
      valid: [{ name: 'a' } as discovery.CustomNodeManifest],
      manifestWarnings: [{ name: 'a', warnings: ['w1'] }],
      errors: [{ dir: 'bad', error: 'x' }],
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.health(undefined)).resolves.toEqual({
      summary: { validCount: 1, nodesWithWarnings: 1, invalidFolders: 1 },
      manifestWarnings: [{ name: 'a', warnings: ['w1'] }],
      errors: [{ dir: 'bad', error: 'x' }],
    });
    expect(spy).toHaveBeenCalledWith(discovery.CUSTOM_NODES_DIR);
    spy.mockRestore();
  });

  it('health with nodeName scopes warnings and errors', async () => {
    const spy = vi.spyOn(discovery, 'discoverCustomNodes').mockReturnValueOnce({
      valid: [
        { name: 'keep', nodePath: '/p/keep' } as discovery.CustomNodeManifest,
        { name: 'other', nodePath: '/p/other' } as discovery.CustomNodeManifest,
      ],
      manifestWarnings: [
        { name: 'keep', warnings: ['wa'] },
        { name: 'other', warnings: ['wb'] },
      ],
      errors: [
        { dir: 'keep', error: 'e1' },
        { dir: 'gone', error: 'e2' },
      ],
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.health({ nodeName: 'keep' })).resolves.toEqual({
      summary: { valid: true, warningCount: 1, errorCount: 1 },
      manifestWarnings: [{ name: 'keep', warnings: ['wa'] }],
      errors: [{ dir: 'keep', error: 'e1' }],
      manifest: { name: 'keep', nodePath: '/p/keep' },
    });
    spy.mockRestore();
  });

  it('readEntrypoint rejects invalid nodeName via Zod', async () => {
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.readEntrypoint({ nodeName: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.readEntrypoint({ nodeName: 'Invalid_Name' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('delete reports NOT_FOUND, not success, when no user node folder was removed', async () => {
    removeLocalCustomNodeFolderMock.mockResolvedValueOnce({ ok: true, removed: false });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.delete({ name: 'posthog_list_errors' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(clearCredentialsForNodeMock).not.toHaveBeenCalled();
  });

  it('delete refuses the machine-owned integrations folder name', async () => {
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.delete({ name: 'integrations' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(removeLocalCustomNodeFolderMock).not.toHaveBeenCalled();
  });

  it('health rejects invalid nodeName via Zod', async () => {
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.health({ nodeName: '../x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('readEntrypoint returns preview from readCustomNodeEntrypointPreview', async () => {
    const spy = vi.spyOn(discovery, 'readCustomNodeEntrypointPreview').mockReturnValueOnce({
      ok: true,
      path: '/x/run.js',
      content: '// hi',
      truncated: false,
      language: 'javascript',
    });
    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(caller.readEntrypoint({ nodeName: 'my-node' })).resolves.toEqual({
      ok: true,
      path: '/x/run.js',
      content: '// hi',
      truncated: false,
      language: 'javascript',
    });
    expect(spy).toHaveBeenCalledWith('my-node');
    spy.mockRestore();
  });

  it('holds a fresh manifest read lease while running dynamic options', async () => {
    const manifest = {
      name: 'my-node',
      displayName: 'My Node',
      description: '',
      version: '1.0.0',
      entrypoint: 'run.js',
      timeout: 60,
      inputs: {},
      credentials: {},
      nodePath: '/Users/x/.frink/nodes/my-node',
    } as discovery.CustomNodeManifest;
    const spy = vi.spyOn(discovery, 'discoverCustomNodes').mockReturnValueOnce({
      valid: [manifest],
      manifestWarnings: [],
      errors: [],
    });

    const caller = customNodesRouter.createCaller({ getWindow: () => null });
    await expect(
      caller.runNodeScript({ nodeName: 'my-node', args: ['--list-options', 'repo'] }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(runCustomNodeScriptMock).toHaveBeenCalledWith(manifest, ['--list-options', 'repo'], {
      skipReadLease: true,
    });
    spy.mockRestore();
  });
});
