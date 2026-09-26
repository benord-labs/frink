import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProviderById } from '../../../../../shared/integrations/selectors';
import type { RegistrarContext } from '../index';
import { fakeClickupApi } from '../test-helpers';
import { clickupRegistrar, getClickupWorkspaces } from '.';

function context(): RegistrarContext {
  const provider = getProviderById('linear');
  if (!provider) throw new Error('Linear fixture missing');
  const ctx: RegistrarContext = {
    provider: {
      ...provider,
      id: 'clickup',
      events: [
        {
          id: 'task_created',
          label: 'Task created',
          description: '',
          filter_field_ids: [],
          vendor_events: ['taskCreated'],
        },
      ],
    },
    token: 'pk_private',
    webhookUrl: 'https://frink.example/api/triggers/clickup/private',
    integration: {
      id: 'integration',
      external_workspace_id: null,
    },
    endpoint: {
      id: 'endpoint',
      webhook_secret: 'old-secret',
      vendor_ref: null,
    },
  };
  ctx.saveProgress = async (value) => {
    ctx.endpoint.vendor_ref = `pending:${value}`;
  };
  return ctx;
}

/** The stub replaces global fetch, which every call site here relies on. */
function fakeApi() {
  const api = fakeClickupApi();
  vi.stubGlobal('fetch', api.fetch);
  return api;
}

async function connect(ctx: RegistrarContext) {
  const result = await clickupRegistrar.register(ctx);
  ctx.endpoint.vendor_ref = result.vendorRef;
  ctx.endpoint.webhook_secret = result.secret!;
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe('ClickUp REST trigger registration', () => {
  it('validates the API key and offers workspaces without mutation', async () => {
    const api = fakeApi();
    expect(await getClickupWorkspaces('pk_private')).toEqual([{ id: '1', label: 'Workspace' }]);
    expect(api.mutations).toEqual([]);
  });

  it('creates once and recovers its vendor secret on subsequent connects', async () => {
    const api = fakeApi();
    const ctx = context();
    const first = await connect(ctx);
    expect(first.secret).toBe('secret-1');
    expect(await connect(ctx)).toEqual(first);
    expect(api.mutations).toEqual([{ method: 'POST', workspaceId: '1' }]);
    expect(first.vendorRef).not.toContain(first.secret!);
  });

  it('requires one explicit workspace when the key can access several', async () => {
    const api = fakeApi();
    const ctx = context();
    api.state.workspaces.push({ id: '2', name: 'Other' });
    await expect(connect(ctx)).rejects.toMatchObject({
      reason: 'Choose one ClickUp workspace for this trigger.',
    });
    expect(api.mutations).toEqual([]);
    ctx.selection = ['2'];
    await connect(ctx);
    expect(api.mutations).toEqual([{ method: 'POST', workspaceId: '2' }]);
  });

  it('refuses inaccessible or multiple selections before remote writes', async () => {
    const api = fakeApi();
    const ctx = context();
    for (const selection of [['2'], ['1', '2']]) {
      ctx.selection = selection;
      await expect(connect(ctx)).rejects.toThrow();
    }
    expect(api.mutations).toEqual([]);
  });

  it('recovers a lost create response using the persisted workspace and exact destination', async () => {
    const api = fakeApi();
    const ctx = context();
    api.state.loseCreate = true;
    await expect(connect(ctx)).rejects.toThrow();
    expect(ctx.endpoint.vendor_ref).toBe('pending:{"workspaceId":"1","webhookId":null}');
    const recovered = await connect(ctx);
    expect(recovered.secret).toBe('secret-1');
    expect(api.mutations).toHaveLength(1);
  });

  it('updates event subscriptions on the owned destination without creating a duplicate', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    api.hooks.get('hook-1')!.events = ['taskUpdated'];
    await connect(ctx);
    expect(api.hooks.get('hook-1')!.events).toEqual(['taskCreated']);
    expect(api.mutations.map((m) => m.method)).toEqual(['POST', 'PUT']);
  });

  it('does not mutate another destination even if its ID is the saved reference', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    api.hooks.get('hook-1')!.endpoint = 'https://other.example/hook';
    await expect(clickupRegistrar.remove(ctx)).rejects.toThrow();
    expect(api.mutations).toHaveLength(1);
  });

  it('confirms a lost delete response and leaves unrelated subscriptions alone', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    api.hooks.set('other', {
      ...api.hooks.get('hook-1')!,
      id: 'other',
      endpoint: 'https://other.example/hook',
    });
    api.state.loseDelete = true;
    await clickupRegistrar.remove(ctx);
    expect([...api.hooks.keys()]).toEqual(['other']);
    await clickupRegistrar.remove(ctx);
    expect(api.mutations.map((m) => m.method)).toEqual(['POST', 'DELETE']);
  });

  it('rotates by recreating and returns the new ID and vendor-issued secret', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    const rotated = await clickupRegistrar.rotate(ctx);
    expect(rotated.secret).toBe('secret-2');
    expect(ctx.endpoint.vendor_ref).toContain('hook-2');
    expect(api.mutations.map((m) => m.method)).toEqual(['POST', 'DELETE', 'POST']);
  });

  it('refuses ambiguous duplicate destinations and API failures without exposing secrets', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    api.hooks.set('duplicate', {
      ...api.hooks.get('hook-1')!,
      id: 'duplicate',
    });
    await expect(connect(ctx)).rejects.toThrow();
    expect(api.mutations).toHaveLength(1);
    api.state.deny = true;
    await expect(getClickupWorkspaces('pk_private')).rejects.toMatchObject({
      message: 'ClickUp subscription request failed',
    });
  });
});
