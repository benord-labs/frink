import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getProviderById } from '../../../../../shared/integrations/selectors';
import type { RegistrarContext } from '../index';
import { createCloudflareRegistrar } from './index';
import {
  accounts,
  destinationSchema,
  eligible as webhookEligible,
  policySchema,
  type McpCaller,
  type Policy,
  type Destination,
  type ApiRequest,
} from './api';

function context(): RegistrarContext {
  const provider = getProviderById('cloudflare');
  if (!provider) throw new Error('Cloudflare provider missing');
  const ctx: RegistrarContext = {
    provider,
    token: 'notifications-token',
    webhookUrl: 'https://frink.example/api/triggers/cloudflare/private',
    selection: ['account:original'],
    integration: {
      id: 'int-cloudflare',
      external_workspace_id: null,
    },
    endpoint: {
      id: 'endpoint',
      webhook_secret: 'test-secret',
      vendor_ref: null,
    },
  };
  ctx.saveProgress = async (ref) => {
    ctx.endpoint.vendor_ref = `pending:${ref}`;
  };
  return ctx;
}

function fakeApi() {
  const policies: Policy[] = [
    {
      id: 'original',
      name: 'API health',
      enabled: true,
      alert_type: 'health_check_status_notification',
      alert_interval: '30m',
      filters: { health_check_id: ['checkout'], new_health: ['Unhealthy'] },
      mechanisms: { email: [{ id: 'owner@example.com' }] },
    },
  ];
  const destinations: Destination[] = [];
  const mutations: ApiRequest[] = [];
  let eligible = true;
  let failAfter: string | undefined;
  let deny = false;
  let persistCheck: (() => void) | undefined;
  const caller: McpCaller = async (url, tool, args, headers) => {
    expect(url).toBe('https://mcp.cloudflare.com/mcp');
    expect(tool).toBe('execute');
    expect(headers).toEqual({ Authorization: 'Bearer notifications-token' });
    const { code } = z.object({ code: z.string() }).parse(args);
    const input: ApiRequest = JSON.parse(
      code.slice('async () => await cloudflare.request('.length, -1),
    );
    if (deny) throw new Error('private token response must never escape');
    if (input.path === '/accounts')
      return reply(input.query?.page === 1 ? [{ id: 'account', name: 'Production' }] : [], {
        page: input.query?.page,
        per_page: 50,
        count: input.query?.page === 1 ? 1 : 0,
        total_count: 1,
      });
    expect(args.account_id).toBe('account');
    if (input.path.endsWith('/eligible'))
      return reply({
        email: { eligible: true, ready: true, type: 'email' },
        pagerduty: { eligible: false, ready: false, type: 'pagerduty' },
        webhooks: { type: 'webhooks', eligible, ready: true },
      });
    const isPolicy = input.path.includes('/policies');
    const collection = isPolicy ? policies : destinations;
    if (input.method === 'GET') return reply(collection);
    persistCheck?.();
    mutations.push(input);
    const id = input.path.split('/').at(-1);
    if (input.method === 'POST') {
      const created = {
        ...input.body,
        id: `${isPolicy ? 'policy' : 'destination'}-${collection.length}`,
      };
      // The fake keeps the same list/create shapes as the documented API.
      if (isPolicy) policies.push(policySchema.parse(created));
      else destinations.push(destinationSchema.parse(created));
      if (failAfter === (isPolicy ? 'policy' : 'destination')) {
        failAfter = undefined;
        throw new Error('connection closed after commit');
      }
      return reply({ id: created.id });
    }
    const index = collection.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('missing');
    if (input.method === 'DELETE') collection.splice(index, 1);
    else Object.assign(collection[index], input.body);
    return reply({ id });
  };
  return {
    caller,
    policies,
    destinations,
    mutations,
    setEligible(value: boolean) {
      eligible = value;
    },
    loseCreate(kind: string) {
      failAfter = kind;
    },
    denyAccess() {
      deny = true;
    },
    requirePersisted(check: () => void) {
      persistCheck = check;
    },
  };
}

type ReplyInfo = { page?: string | number; per_page: number; count: number; total_count: number };
type ReplyPayload<T> = { success: true; result: T; result_info?: ReplyInfo };

function reply<T>(result: T, resultInfo?: ReplyInfo) {
  const payload: ReplyPayload<T> = { success: true, result };
  if (resultInfo) payload.result_info = resultInfo;
  return {
    ok: true as const,
    result: { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] },
  };
}

describe('Cloudflare automatic notifications', () => {
  it('offers enabled source policies, excluding disabled ones and Frink copies', async () => {
    const api = fakeApi();
    api.policies.push(
      { ...api.policies[0], id: 'disabled', enabled: false },
      {
        ...api.policies[0],
        id: 'copy',
        name: 'Frink Flow other',
        description: 'Frink Flow endpoint-1',
      },
      { ...api.policies[0], id: 'named', name: 'Frink Flow outages' },
    );
    const result = await createCloudflareRegistrar(api.caller).setupOptions?.({
      token: 'notifications-token',
    });
    expect(result).toEqual({
      selection: 'many',
      options: [
        { id: 'account:original', label: 'Production · API health' },
        { id: 'account:named', label: 'Production · Frink Flow outages' },
      ],
    });
  });
  it('reads accounts across pages without requiring undocumented total_pages', async () => {
    const pages: number[] = [];
    const caller: McpCaller = async (_url, _tool, args) => {
      const { code } = z.object({ code: z.string() }).parse(args);
      const input: ApiRequest = JSON.parse(
        code.slice('async () => await cloudflare.request('.length, -1),
      );
      const page = Number(input.query?.page);
      pages.push(page);
      return reply(page < 3 ? [{ id: `account-${page}`, name: `Account ${page}` }] : [], {
        page,
        count: page < 3 ? 1 : 0,
        per_page: 50,
        total_count: 2,
      });
    };
    await expect(accounts(caller, 'notifications-token')).resolves.toHaveLength(2);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('refuses a repeated account page instead of looping or duplicating choices', async () => {
    const caller: McpCaller = async () => reply([{ id: 'account', name: 'Production' }]);
    await expect(accounts(caller, 'notifications-token')).rejects.toThrow(/pagination/);
  });

  it.each([
    {},
    { eligible: true },
    { eligible: true, ready: false },
    { eligible: false, ready: true },
  ])(
    'requires positive webhook eligibility and readiness from the live object shape: %j',
    async (webhooks) => {
      const caller: McpCaller = async () => reply({ email: {}, pagerduty: {}, webhooks });
      await expect(webhookEligible(caller, 'notifications-token', 'account')).resolves.toBe(false);
    },
  );

  it('persists scope before mutations and preserves conditions without changing original recipients', async () => {
    const api = fakeApi();
    const ctx = context();
    const original = structuredClone(api.policies[0]);
    api.requirePersisted(() => expect(ctx.endpoint.vendor_ref).toContain('pending:'));
    const registrar = createCloudflareRegistrar(api.caller);
    const registered = await registrar.register(ctx);
    ctx.endpoint.vendor_ref = registered.vendorRef;
    const own = api.policies[1];
    expect(api.policies[0]).toEqual(original);
    expect(own.filters).toEqual(original.filters);
    expect(own.alert_interval).toBe('30m');
    expect(own.mechanisms).toEqual({ webhooks: [{ id: api.destinations[0].id }] });
    await registrar.register(ctx);
    expect(api.policies).toHaveLength(2);
    expect(api.destinations).toHaveLength(1);
    await registrar.remove(ctx);
    expect(api.policies).toEqual([original]);
    expect(api.destinations).toEqual([]);
    expect(
      api.mutations.filter((item) => item.method === 'DELETE').map((item) => item.path),
    ).toEqual([
      '/accounts/account/alerting/v3/policies/policy-1',
      '/accounts/account/alerting/v3/destinations/webhooks/destination-0',
    ]);
  });
  it.each(['destination', 'policy'])(
    'recovers a lost %s create without duplication',
    async (kind) => {
      const api = fakeApi();
      const ctx = context();
      const registrar = createCloudflareRegistrar(api.caller);
      api.loseCreate(kind);
      await expect(registrar.register(ctx)).rejects.toThrow('Cloudflare POST');
      expect(ctx.endpoint.vendor_ref).toContain('pending:');
      await registrar.register(ctx);
      expect(api.destinations).toHaveLength(1);
      expect(api.policies).toHaveLength(2);
    },
  );
  it('can remove a lost-create destination before a policy existed', async () => {
    const api = fakeApi();
    const ctx = context();
    const registrar = createCloudflareRegistrar(api.caller);
    api.loseCreate('destination');
    await expect(registrar.register(ctx)).rejects.toThrow();
    await registrar.remove(ctx);
    expect(api.destinations).toEqual([]);
    expect(api.policies).toHaveLength(1);
  });
  it('never creates a destination for an ineligible account or disabled source', async () => {
    const api = fakeApi();
    const registrar = createCloudflareRegistrar(api.caller);
    api.setEligible(false);
    await expect(registrar.register(context())).rejects.toThrow('ineligible');
    api.setEligible(true);
    api.policies[0].enabled = false;
    await expect(registrar.register(context())).rejects.toThrow('absent or disabled');
    expect(api.mutations).toEqual([]);
  });
  it('requires a selection from exactly one account', async () => {
    const api = fakeApi();
    const registrar = createCloudflareRegistrar(api.caller);
    const ctx = context();
    ctx.selection = undefined;
    await expect(registrar.register(ctx)).rejects.toThrow('selection required');
    ctx.selection = ['account:original', 'other:policy'];
    await expect(registrar.register(ctx)).rejects.toThrow('multiple notification accounts');
    expect(api.mutations).toEqual([]);
  });
  it('retains cleanup state on inaccessible account and redacts vendor errors', async () => {
    const api = fakeApi();
    const ctx = context();
    const registrar = createCloudflareRegistrar(api.caller);
    const result = await registrar.register(ctx);
    ctx.endpoint.vendor_ref = result.vendorRef;
    api.denyAccess();
    await expect(registrar.remove(ctx)).rejects.toThrow('Cloudflare GET');
    expect(ctx.endpoint.vendor_ref).toBe(result.vendorRef);
    await expect(registrar.register(ctx)).rejects.not.toThrow('private token');
  });
  it('refuses to delete repurposed owned resources', async () => {
    const api = fakeApi();
    const ctx = context();
    const registrar = createCloudflareRegistrar(api.caller);
    ctx.endpoint.vendor_ref = (await registrar.register(ctx)).vendorRef;
    api.destinations[0].url = 'https://elsewhere.example/';
    await expect(registrar.remove(ctx)).rejects.toThrow('ownership');
    expect(api.destinations).toHaveLength(1);
    expect(api.policies).toHaveLength(2);
  });
  it('keeps a destination another policy now references', async () => {
    const api = fakeApi();
    const ctx = context();
    const registrar = createCloudflareRegistrar(api.caller);
    ctx.endpoint.vendor_ref = (await registrar.register(ctx)).vendorRef;
    api.policies[0].mechanisms.webhooks = [{ id: api.destinations[0].id }];
    await expect(registrar.remove(ctx)).rejects.toThrow('unowned policy');
    expect(api.destinations).toHaveLength(1);
    expect(api.policies).toHaveLength(1);
  });
  it('rotates only the owned destination secret', async () => {
    const api = fakeApi();
    const ctx = context();
    const registrar = createCloudflareRegistrar(api.caller);
    ctx.endpoint.vendor_ref = (await registrar.register(ctx)).vendorRef;
    ctx.endpoint.webhook_secret = 'rotated';
    await registrar.rotate(ctx);
    expect(api.mutations.at(-1)?.body?.secret).toBe('rotated');
    expect(api.policies[0].mechanisms.email).toEqual([{ id: 'owner@example.com' }]);
  });
});
