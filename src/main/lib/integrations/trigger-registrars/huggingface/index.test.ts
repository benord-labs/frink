import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProviderById } from '../../../../../shared/integrations/selectors';
import type { RegistrarContext } from '../index';
import { huggingfaceRegistrar } from '.';

function context(): RegistrarContext {
  const provider = getProviderById('huggingface');
  if (!provider) throw new Error('Hugging Face fixture missing');
  const ctx: RegistrarContext = {
    provider,
    token: 'hf_test',
    selection: ['user:example'],
    webhookUrl: 'https://frink.example/api/triggers/huggingface/private',
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

type Hook = {
  id: string;
  url: string;
  watched: { type: string; name: string }[];
  domains: string[];
  secret: string;
  disabled: boolean | 'suspended-after-failure';
};
/** The public API exposes only presence; it never echoes the stored signing secret. */
function publicWebhook({ secret, ...hook }: Hook) {
  return { ...hook, hasSecret: Boolean(secret) };
}
function fakeApi() {
  const hooks = new Map<string, Hook>();
  const mutations: string[] = [];
  const state = {
    created: 0,
    loseCreate: false,
    loseDelete: false,
    deny: false,
    invalidResource: false,
    failUpdate: false,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer hf_test');
      if (state.deny) return new Response('private-key private-secret', { status: 403 });
      const path = new URL(url).pathname.replace('/api/settings/webhooks', '');
      const method = init.method || 'GET';
      if (method === 'GET' && !path) return Response.json([...hooks.values()].map(publicWebhook));
      mutations.push(method + ' ' + path);
      if (state.invalidResource && method === 'POST')
        return new Response('private-key private-resource', { status: 400 });
      if (!path) {
        // SAFETY: the fake echoes the create body the registrar sent, which is a Hook.
        const hook = {
          ...JSON.parse(String(init.body)),
          id: 'hook-' + ++state.created,
          disabled: false,
        } as Hook;
        hooks.set(hook.id, hook);
        if (state.loseCreate) {
          state.loseCreate = false;
          throw new Error('lost response');
        }
        return Response.json({ webhook: publicWebhook(hook) });
      }
      const hook = hooks.get(path.split('/')[1]);
      if (!hook) return new Response('', { status: 404 });
      if (method === 'DELETE') {
        hooks.delete(hook.id);
        if (state.loseDelete) {
          state.loseDelete = false;
          throw new Error('lost delete');
        }
        return Response.json({});
      }
      if (state.failUpdate) return new Response('private failure', { status: 503 });
      if (path.endsWith('/enable')) hook.disabled = false;
      else Object.assign(hook, JSON.parse(String(init.body)));
      return Response.json({ webhook: publicWebhook(hook) });
    }),
  );
  return { hooks, mutations, state };
}

afterEach(() => vi.unstubAllGlobals());

async function connect(ctx: RegistrarContext) {
  const result = await huggingfaceRegistrar.register(ctx);
  ctx.endpoint.vendor_ref = result.vendorRef;
  return result;
}

describe('Hugging Face registrar', () => {
  it('validates access without writing and creates one correctly configured subscription', async () => {
    const api = fakeApi();
    const ctx = context();
    await expect(huggingfaceRegistrar.setupOptions!({ token: ctx.token })).resolves.toEqual({
      options: [],
      selection: 'many',
    });
    expect(api.mutations).toEqual([]);
    const first = await connect(ctx);
    expect(await connect(ctx)).toEqual(first);
    expect(api.hooks.get('hook-1')).toMatchObject({
      url: ctx.webhookUrl,
      secret: 'old-secret',
      watched: [{ type: 'user', name: 'example' }],
      domains: ['repo', 'discussion'],
      disabled: false,
    });
    expect(api.state.created).toBe(1);
    expect(first.vendorRef).not.toContain(ctx.endpoint.webhook_secret);
  });
  it('recovers a lost create using persisted scope and exact URL without creating twice', async () => {
    const api = fakeApi();
    const ctx = context();
    api.state.loseCreate = true;
    await expect(connect(ctx)).rejects.toThrow();
    expect(ctx.endpoint.vendor_ref).toContain('pending:');
    ctx.selection = undefined;
    await connect(ctx);
    expect(api.state.created).toBe(1);
  });
  it('repairs disabled subscriptions, drifted domains, watch scope and secret before reporting success', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    Object.assign(api.hooks.get('hook-1')!, {
      disabled: 'suspended-after-failure',
      secret: 'wrong',
      domains: [],
      watched: [],
    });
    await connect(ctx);
    expect(api.hooks.get('hook-1')).toMatchObject({
      disabled: false,
      secret: 'old-secret',
      domains: ['repo', 'discussion'],
      watched: [{ type: 'user', name: 'example' }],
    });
    expect(api.state.created).toBe(1);
    expect(api.mutations).toContain('POST /hook-1/enable');
  });
  it('rotates the secret while preserving selected resources; a failure is recoverable', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    ctx.selection = undefined;
    ctx.endpoint.webhook_secret = 'rotated';
    api.state.failUpdate = true;
    await expect(huggingfaceRegistrar.rotate(ctx)).rejects.toThrow();
    api.state.failUpdate = false;
    await huggingfaceRegistrar.rotate(ctx);
    expect(api.hooks.get('hook-1')).toMatchObject({
      secret: 'rotated',
      watched: [{ type: 'user', name: 'example' }],
    });
    expect(api.state.created).toBe(1);
  });
  it('reapplies a write-only secret even when all readable settings match', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    api.hooks.get('hook-1')!.secret = 'changed-at-vendor';
    await connect(ctx);
    expect(api.hooks.get('hook-1')!.secret).toBe('old-secret');
    expect(api.state.created).toBe(1);
  });
  it('explains an invalid resource without suggesting reconnection or exposing the vendor body', async () => {
    const api = fakeApi();
    api.state.invalidResource = true;
    await expect(connect(context())).rejects.toMatchObject({
      reason:
        'Hugging Face rejected this setup. Check the resource type and enter an existing user, organization, or repository name.',
      status: 400,
      message: 'Hugging Face webhook request failed',
    });
  });
  it('settles lost deletes and leaves unrelated webhooks alone', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    api.hooks.set('other', {
      ...api.hooks.get('hook-1')!,
      id: 'other',
      url: 'https://other.example/webhook',
    });
    api.state.loseDelete = true;
    await huggingfaceRegistrar.remove(ctx);
    await huggingfaceRegistrar.remove(ctx);
    expect([...api.hooks.keys()]).toEqual(['other']);
  });
  it('refuses moved or ambiguous destinations without changing other subscriptions', async () => {
    const api = fakeApi();
    const ctx = context();
    await connect(ctx);
    const hook = api.hooks.get('hook-1')!;
    hook.url = 'https://other.example/webhook';
    await expect(huggingfaceRegistrar.remove(ctx)).rejects.toThrow();
    hook.url = ctx.webhookUrl;
    api.hooks.set('duplicate', { ...hook, id: 'duplicate' });
    await expect(connect(ctx)).rejects.toThrow();
    expect(api.mutations).toHaveLength(1);
  });
  it('requires an explicit valid scope and redacts vendor errors', async () => {
    const api = fakeApi();
    const ctx = context();
    ctx.selection = undefined;
    await expect(connect(ctx)).rejects.toThrow();
    ctx.selection = ['unsupported:resource'];
    await expect(connect(ctx)).rejects.toThrow();
    expect(api.mutations).toEqual([]);
    api.state.deny = true;
    await expect(huggingfaceRegistrar.setupOptions!({ token: ctx.token })).rejects.toMatchObject({
      message: 'Hugging Face webhook request failed',
    });
  });
});
