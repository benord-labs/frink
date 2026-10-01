import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as pluginInstallations from '../../db/repos/plugin-installations';
import { findLocalIntegration } from '../../db/repos/webhook-ingress';
import { freshDb } from '../../db/test-utils/fresh-db';
import { createId } from '../../db/utils';
import * as tokenCrypto from '../../credentials/token-crypto';
import { withPluginLifecycleOperation } from '../../integrations/connection-lifecycle-operation';

const { getDatabaseMock, getGlobalMcpServersMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
  getGlobalMcpServersMock: vi.fn(),
}));

// The real probe opens a live connection to the provider's MCP server; its own suite covers it.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../integrations/plugin-node-derivation/schema-cache', () => ({
  probeSchemasBestEffort: vi.fn(async () => {}),
}));

vi.mock('../../mcp', () => ({
  getGlobalMcpServers: getGlobalMcpServersMock,
}));

vi.mock('../../db', () => ({
  getDatabase: getDatabaseMock,
  claudeCodeCredentials: {
    oauthToken: 'oauthToken',
    type: 'type',
    isDefault: 'isDefault',
    connectedAt: 'connectedAt',
  },
}));

/** The real local tables the router reads to decide whether an id names an account it holds. */
const localDb = freshDb();

beforeEach(() => {
  getDatabaseMock.mockReset();
  getDatabaseMock.mockReturnValue(localDb);
});

async function createCaller() {
  const { integrationsRouter } = await import('./integrations');
  return integrationsRouter.createCaller({
    getWindow: () => null,
  });
}

function signedIn() {}

describe('integrationsRouter webhook endpoints', () => {
  beforeEach(() => {
    signedIn();
    getGlobalMcpServersMock.mockReset().mockResolvedValue({});
  });

  // Ids minted on this machine are base-36, not UUIDs, so every endpoint input takes opaque text.
  it('refuses an id that names no account here and still rejects an empty one', async () => {
    const caller = await createCaller();
    const local = { integrationId: createId(), webhookId: createId() };

    expect(
      await caller.testWebhookEndpoint({
        integrationId: local.integrationId,
        endpointId: local.webhookId,
        eventId: 'story_created',
      }),
    ).toEqual({ success: false, error: 'Active trigger not found.' });
    expect(await caller.rotateWebhookEndpoint(local)).toEqual({
      success: false,
      error: 'This trigger account is not on this machine.',
    });
    expect(await caller.deactivateWebhookEndpoint(local)).toEqual({
      success: false,
      error: 'This trigger account is not on this machine.',
    });
    await expect(caller.rotateWebhookEndpoint({ ...local, webhookId: '' })).rejects.toThrow();
  });

  it('refuses to disconnect an id this machine does not hold', async () => {
    const caller = await createCaller();
    await expect(
      caller.disconnectIntegration({ integrationId: 'someone-elses-id' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('integrationsRouter connectWebhookOnly', () => {
  beforeEach(() => {
    signedIn();
  });

  it('lists a Shortcut trigger account held on this machine', async () => {
    const caller = await createCaller();
    const created = await caller.connectWebhookOnly({ provider: 'shortcut', label: 'Workspace' });

    const listed = await caller.list();
    expect(listed).toContainEqual(
      expect.objectContaining({
        id: created.integration.id,
        provider: 'shortcut',
        accountIdentifier: 'Shortcut',
        isActive: true,
      }),
    );
    expect(listed.every((row) => row.provider === 'shortcut')).toBe(true);
  });

  it('waits for the plugin lifecycle lock before minting, so Remove and Set up cannot interleave', async () => {
    vi.spyOn(tokenCrypto, 'encryptToken').mockImplementation((value) => `sealed:${value}`);
    vi.spyOn(tokenCrypto, 'decryptToken').mockImplementation((value) =>
      value?.startsWith('sealed:') ? value.slice(7) : null,
    );
    const caller = await createCaller();
    const created = await caller.connectWebhookOnly({ provider: 'shortcut', label: 'Workspace' });
    let release!: () => void;
    const held = withPluginLifecycleOperation(
      'shortcut',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let minted = false;
    const generate = caller
      .generateWebhookEndpoint({ integrationId: created.integration.id })
      .then((result) => {
        minted = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(minted).toBe(false);

    release();
    await held;
    await expect(generate).resolves.toMatchObject({ success: true });
  });

  it('forgets a Shortcut trigger account held on this machine', async () => {
    const caller = await createCaller();
    const created = await caller.connectWebhookOnly({ provider: 'shortcut', label: 'Workspace' });

    await expect(
      caller.disconnectIntegration({ integrationId: created.integration.id }),
    ).resolves.toEqual({ success: true, cleanupPending: false });
    expect(await findLocalIntegration(localDb, created.integration.id)).toBeUndefined();
  });

  it('keeps a Shortcut trigger account on this machine and never asks the Frink backend', async () => {
    const caller = await createCaller();
    const created = await caller.connectWebhookOnly({
      provider: 'shortcut',
      label: 'Shortcut workspace',
    });
    expect(created.integration).toMatchObject({
      provider: 'shortcut',
      accountIdentifier: 'Shortcut',
    });
    expect(await caller.listWebhookEndpoints({ integrationId: created.integration.id })).toEqual({
      success: true,
      singleEndpoint: false,
      endpoints: [],
    });
  });

  it('accepts optional trigger accounts and refuses a provider Frink does not serve', async () => {
    const caller = await createCaller();
    const created = await caller.connectWebhookOnly({ provider: 'posthog', label: 'PostHog' });
    expect(created.integration).toMatchObject({
      provider: 'posthog',
      accountIdentifier: 'PostHog',
    });
    await expect(
      caller.connectWebhookOnly({ provider: 'docusign', label: 'DocuSign' }),
    ).rejects.toThrow();
  });

  it('lists a local account through integrations.list', async () => {
    const caller = await createCaller();
    const created = await caller.connectWebhookOnly({ provider: 'posthog', label: 'CI' });

    expect((await caller.list()).map((row) => row.id)).toContain(created.integration.id);
  });
});

describe('integrationsRouter retryWebhookEndpoint', () => {
  beforeEach(() => {
    signedIn();
  });

  it('refuses a paused plugin before any vendor call', async () => {
    const caller = await createCaller();
    const created = await caller.connectWebhookOnly({ provider: 'posthog', label: 'CI' });
    vi.spyOn(pluginInstallations, 'getByPluginId').mockResolvedValue(null);
    try {
      await expect(
        caller.retryWebhookEndpoint({
          integrationId: created.integration.id,
          webhookId: 'endpoint-1',
        }),
      ).rejects.toThrow('Turn the plugin on');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses an id that names no account on this machine', async () => {
    const caller = await createCaller();
    // The card renders only a thrown error for Retry, so the refusal is thrown, not returned.
    await expect(
      caller.retryWebhookEndpoint({ integrationId: createId(), webhookId: createId() }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'This trigger account is not on this machine.',
    });
  });
});
