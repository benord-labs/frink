import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getProviderById } from '../../../../shared/integrations/selectors';
import type { McpToolCallResult, callMcpTool } from '../../mcp/tools-probe/call';
import type { RegistrarContext } from './index';
import { createWebflowRegistrar } from './webflow';

const TOKEN = 'webflow-test-token';
const URL = 'https://frink.example/api/triggers/webflow/test-capability';
const actionSchema = z.object({
  context: z.string().min(1),
  actions: z.tuple([
    z.union([
      z
        .object({
          label: z.string(),
          list_sites: z
            .object({
              limit: z.number().int().positive(),
              offset: z.number().int().nonnegative(),
              detail: z.literal('summary'),
            })
            .strict(),
        })
        .strict(),
      z.object({ label: z.string(), list_webhooks: z.object({ site_id: z.string() }) }).strict(),
      z
        .object({
          label: z.string(),
          create_webhook: z
            .object({ site_id: z.string(), trigger_type: z.string(), url: z.string() })
            .strict(),
        })
        .strict(),
      z.object({ label: z.string(), get_webhook: z.object({ webhook_id: z.string() }) }).strict(),
      z
        .object({ label: z.string(), delete_webhook: z.object({ webhook_id: z.string() }) })
        .strict(),
    ]),
  ]),
});
type Hook = { id: string; siteId: string; triggerType: string; url: string };

function reply<T>(value: T, action: string): McpToolCallResult {
  return {
    ok: true,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ label: action, action, result: value }) }],
    },
  };
}

function context(vendorRef: string | null = null): RegistrarContext {
  const provider = getProviderById('webflow');
  if (!provider) throw new Error('Webflow provider missing');
  const ctx: RegistrarContext = {
    provider,
    token: TOKEN,
    webhookUrl: URL,
    integration: {
      id: 'int-webflow',
      external_workspace_id: 'webflow',
    },
    endpoint: {
      id: 'ep-1',
      webhook_secret: 'test-secret',
      vendor_ref: vendorRef,
    },
  };
  ctx.saveProgress = async (ref) => {
    ctx.endpoint.vendor_ref = `pending:${ref}`;
  };
  return ctx;
}

/** Fake the official MCP action contract, including an ambiguous response after a successful write. */
function fakeWebflow() {
  const mutations: string[] = [];
  const reads: string[] = [];
  const pageOffsets: number[] = [];
  const state = {
    sites: ['site-a', 'site-b'],
    pageSize: 100,
    pageOffsets,
    badPageOffset: -1,
    hooks: new Map<string, Hook>(),
    created: 0,
    mutations,
    reads,
    overrides: new Map<string, McpToolCallResult>(),
    lostCreateAfter: 0,
    inaccessible: new Set<string>(),
    deleteRefused: false,
  };
  const call: typeof callMcpTool = async (serverUrl, tool, args, headers) => {
    expect(serverUrl).toBe('https://mcp.webflow.com/mcp');
    expect(headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    const parsed = actionSchema.parse(args);
    expect(parsed.context.split(/\s+/).length).toBeGreaterThanOrEqual(15);
    expect(parsed.context.split(/\s+/).length).toBeLessThanOrEqual(25);
    const action = parsed.actions[0];
    const name = Object.keys(action).find((key) => key !== 'label');
    expect(action.label).toBe(name);
    expect(tool).toBe('list_sites' in action ? 'data_sites_tool' : 'data_webhook_tool');
    const override = state.overrides.get(action.label);
    if (override) return override;
    if ('list_sites' in action) {
      const { offset, limit } = action.list_sites;
      state.pageOffsets.push(offset);
      const sites = state.sites
        .slice(offset, offset + Math.min(limit, state.pageSize))
        .map((id) => ({ id }));
      return reply(
        {
          sites,
          pagination: {
            total: state.sites.length,
            offset: state.badPageOffset === offset ? 0 : offset,
            returned: sites.length,
            hasMore: offset + sites.length < state.sites.length,
          },
        },
        action.label,
      );
    }
    if ('list_webhooks' in action) {
      const siteId = action.list_webhooks.site_id;
      state.reads.push(siteId);
      if (state.inaccessible.has(siteId))
        return { ok: false, reason: 'transport', message: 'Forbidden' };
      return reply(
        {
          webhooks: [...state.hooks.values()].filter((hook) => hook.siteId === siteId),
        },
        action.label,
      );
    }
    if ('get_webhook' in action) {
      const hook = state.hooks.get(action.get_webhook.webhook_id);
      state.reads.push(action.get_webhook.webhook_id);
      if (!hook || state.inaccessible.has(hook.siteId))
        return { ok: false, reason: 'transport', message: 'Not found or forbidden' };
      return reply(hook, action.label);
    }
    if ('create_webhook' in action) {
      const input = action.create_webhook;
      const hook = {
        id: `hook-${++state.created}`,
        siteId: input.site_id,
        triggerType: input.trigger_type,
        url: input.url,
      };
      state.hooks.set(hook.id, hook);
      state.mutations.push('create');
      if (state.created === state.lostCreateAfter)
        return { ok: false, reason: 'transport', message: 'Response lost' };
      return reply(hook, action.label);
    }
    const id = action.delete_webhook.webhook_id;
    state.mutations.push('delete');
    if (state.deleteRefused)
      return {
        ok: true,
        result: { isError: true, content: [{ type: 'text', text: 'Forbidden' }] },
      };
    state.hooks.delete(id);
    // SDK void responses are not valid JSON text; removal must verify absence independently.
    return { ok: false, reason: 'transport', message: 'Invalid tool result after delete' };
  };
  return { state, registrar: createWebflowRegistrar(call) };
}

describe('Webflow registrar', () => {
  it('discovers every site page before persisting scope and creating subscriptions', async () => {
    const { state, registrar } = fakeWebflow();
    state.pageSize = 1;
    const ctx = context();
    const result = await registrar.register(ctx);
    expect(state.pageOffsets).toEqual([0, 1]);
    expect(JSON.parse(result.vendorRef).sites).toEqual(['site-a', 'site-b']);
    expect(state.hooks.size).toBe(8);
  });

  it('refuses non-progressing site pagination before saving scope or mutating', async () => {
    const { state, registrar } = fakeWebflow();
    state.pageSize = 1;
    state.badPageOffset = 1;
    const ctx = context();
    await expect(registrar.register(ctx)).rejects.toThrow('verify site pagination');
    expect(state.pageOffsets).toEqual([0, 1]);
    expect(ctx.endpoint.vendor_ref).toBeNull();
    expect(state.mutations).toEqual([]);
  });

  it('persists all discovered pages before a create response is lost', async () => {
    const { state, registrar } = fakeWebflow();
    state.pageSize = 1;
    state.lostCreateAfter = 1;
    const ctx = context();
    await expect(registrar.register(ctx)).rejects.toThrow();
    expect(ctx.endpoint.vendor_ref).toBe('pending:{"sites":["site-a","site-b"],"webhooks":[]}');
    expect(state.hooks.size).toBe(1);
  });

  it('registers four catalog events per authorized site and reconnects without duplicate subscriptions', async () => {
    const { state, registrar } = fakeWebflow();
    const first = await registrar.register(context());
    expect(state.hooks.size).toBe(8);
    expect(JSON.parse(first.vendorRef).webhooks).toHaveLength(8);
    expect(new Set([...state.hooks.values()].map((hook) => hook.triggerType))).toEqual(
      new Set([
        'form_submission',
        'site_publish',
        'collection_item_created',
        'collection_item_changed',
      ]),
    );
    await registrar.register(context(first.vendorRef));
    await registrar.register(context());
    expect(state.mutations).toEqual(Array(8).fill('create'));
  });

  it.each([
    { ok: true, result: { isError: true, content: [{ type: 'text', text: '{"webhooks":[]}' }] } },
    reply({ webhooks: null }, 'list_webhooks'),
    reply({ webhooks: [] }, 'get_webhook'),
    { ok: true, result: { content: [{ type: 'text', text: '{"webhooks":null}' }] } },
    { ok: true, result: { content: [{ type: 'text', text: 'invalid JSON' }] } },
    { ok: false, reason: 'transport', message: 'Forbidden' },
  ] satisfies McpToolCallResult[])(
    'refuses error or malformed webhook inventories before creating anything (%#)',
    async (result) => {
      const { state, registrar } = fakeWebflow();
      state.overrides.set('list_webhooks', result);
      await expect(registrar.register(context())).rejects.toThrow();
      expect(state.mutations).toEqual([]);
    },
  );

  it('rejects an empty authorized-site list', async () => {
    const { state, registrar } = fakeWebflow();
    state.sites = [];
    await expect(registrar.register(context())).rejects.toMatchObject({
      reason: expect.stringContaining('No Webflow sites'),
    });
    expect(state.mutations).toEqual([]);
  });

  it('recovers a create whose response was lost without duplicating its subscription', async () => {
    const { state, registrar } = fakeWebflow();
    state.lostCreateAfter = 3;
    await expect(registrar.register(context())).rejects.toThrow();
    expect(state.hooks.size).toBe(3);
    await registrar.register(context());
    expect(state.hooks.size).toBe(8);
    expect(state.created).toBe(8);
  });

  it('removes partially created subscriptions even when no vendor reference was saved', async () => {
    const { state, registrar } = fakeWebflow();
    state.lostCreateAfter = 3;
    await expect(registrar.register(context())).rejects.toThrow();
    await registrar.remove(context());
    expect(state.hooks.size).toBe(0);
    await registrar.remove(context());
    expect(state.mutations.filter((mutation) => mutation === 'delete')).toHaveLength(3);
  });

  it('preserves subscriptions for another address or event', async () => {
    const { state, registrar } = fakeWebflow();
    state.hooks.set('other-url', {
      id: 'other-url',
      siteId: 'site-a',
      triggerType: 'form_submission',
      url: 'https://elsewhere.example/hook',
    });
    state.hooks.set('other-event', {
      id: 'other-event',
      siteId: 'site-a',
      triggerType: 'page_deleted',
      url: URL,
    });
    await registrar.register(context());
    await registrar.remove(context());
    expect([...state.hooks.keys()]).toEqual(['other-url', 'other-event']);
  });

  it('inspects saved handles for a site no longer listed and refuses inaccessible cleanup', async () => {
    const { state, registrar } = fakeWebflow();
    const { vendorRef } = await registrar.register(context());
    state.sites = ['site-a'];
    state.inaccessible.add('site-b');
    await expect(registrar.remove(context(vendorRef))).rejects.toThrow();
    expect(state.reads).toContain('hook-5');
    expect(state.hooks.size).toBe(8);
  });

  it('can clean up a saved site omitted from discovery when its handle and list remain accessible', async () => {
    const { state, registrar } = fakeWebflow();
    const { vendorRef } = await registrar.register(context());
    state.sites = ['site-a'];
    await registrar.remove(context(vendorRef));
    expect(state.hooks.size).toBe(0);
  });

  it('marks saved subscriptions pending before a reconnect discovers revoked access', async () => {
    const { state, registrar } = fakeWebflow();
    const { vendorRef } = await registrar.register(context());
    const ctx = context(vendorRef);
    state.inaccessible.add('site-a');
    await expect(registrar.register(ctx)).rejects.toThrow();
    expect(ctx.endpoint.vendor_ref).toBe(`pending:${vendorRef}`);
    expect(state.hooks.size).toBe(8);
  });

  it('persists attempted sites before a lost create so revoked access cannot masquerade as cleanup', async () => {
    const { state, registrar } = fakeWebflow();
    const ctx = context();
    state.lostCreateAfter = 1;
    await expect(registrar.register(ctx)).rejects.toThrow();
    expect(ctx.endpoint.vendor_ref).toBe('pending:{"sites":["site-a","site-b"],"webhooks":[]}');
    state.sites = ['site-b'];
    state.inaccessible.add('site-a');
    await expect(registrar.remove(ctx)).rejects.toThrow();
    expect(state.hooks.size).toBe(1);
  });

  it('does not mutate the vendor unless progress can be saved first', async () => {
    const { state, registrar } = fakeWebflow();
    const ctx = context();
    ctx.saveProgress = async () => {
      throw new Error('Cloud unavailable');
    };
    await expect(registrar.register(ctx)).rejects.toThrow('Cloud unavailable');
    expect(state.mutations).toEqual([]);
  });

  it('does not call a refused deletion successful while its subscription remains', async () => {
    const { state, registrar } = fakeWebflow();
    const { vendorRef } = await registrar.register(context());
    state.deleteRefused = true;
    await expect(registrar.remove(context(vendorRef))).rejects.toThrow();
    expect(state.hooks.size).toBe(8);
  });

  it.each([null, 'pending:{"sites":[],"webhooks":[]}'])(
    'allows removal after zero-site registration creates no subscriptions (saved refs: %s)',
    async (vendorRef) => {
      const { state, registrar } = fakeWebflow();
      const ctx = context(vendorRef);
      state.sites = [];
      await expect(registrar.register(ctx)).rejects.toThrow(
        'no authorized sites or catalog events',
      );
      expect(ctx.endpoint.vendor_ref).toBe(vendorRef);
      expect(state.mutations).toEqual([]);
      await expect(registrar.remove(ctx)).resolves.toBeUndefined();
      expect(state.mutations).toEqual([]);
    },
  );

  it('refuses cleanup when all saved sites become inaccessible after a lost create', async () => {
    const { state, registrar } = fakeWebflow();
    const ctx = context();
    state.lostCreateAfter = 1;
    await expect(registrar.register(ctx)).rejects.toThrow();
    state.sites = [];
    state.inaccessible.add('site-a');
    state.inaccessible.add('site-b');
    await expect(registrar.remove(ctx)).rejects.toThrow();
    expect(state.hooks.size).toBe(1);
  });

  it('does not rotate an unused vendor secret', async () => {
    const { state, registrar } = fakeWebflow();
    await expect(registrar.rotate(context())).resolves.toEqual({});
    expect(state.mutations).toEqual([]);
  });
});
