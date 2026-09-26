/** Webflow's official MCP owns the credential and webhook API; each call performs one action. */
import { z } from 'zod';
import manifest from '../../../../shared/integrations/catalog/webflow/plugin.json';
import type { callMcpTool } from '../../mcp/tools-probe/call';
import type { RegistrarContext, TriggerRegistrar } from './index';
import { VendorRequestError } from './vendor-http';
import { beforeTriggerVendorRequest } from './operation';

const webhook = z.object({
  id: z.string().min(1),
  siteId: z.string().min(1),
  triggerType: z.string().min(1),
  url: z.string().url(),
});
const webhookList = z.object({ webhooks: z.array(webhook) });
const siteList = z.object({
  sites: z.array(z.object({ id: z.string().min(1) })),
  pagination: z.object({
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
});
const ownedReferences = z
  .object({
    sites: z.array(z.string().min(1)),
    webhooks: z.array(
      z.object({ siteId: z.string().min(1), webhookId: z.string().min(1) }).strict(),
    ),
  })
  .strict();
const toolReply = z.object({
  isError: z.boolean().optional(),
  content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]),
});
type Webhook = z.infer<typeof webhook>;
type McpCaller = typeof callMcpTool;
type Discovery = { siteIds: string[]; attemptedSites: string[]; hooks: Webhook[] };

function refused(action: string): VendorRequestError {
  return new VendorRequestError(
    "Webflow couldn't complete webhook setup. Check its connection and site permissions, then try again.",
    `Webflow ${action} failed or returned an unverifiable response`,
  );
}

async function invoke(
  caller: McpCaller | undefined,
  ctx: RegistrarContext,
  tool: 'data_sites_tool' | 'data_webhook_tool',
  action: Record<string, Record<string, string | number>>,
) {
  await beforeTriggerVendorRequest();
  const call = caller ?? (await import('../../mcp/tools-probe/call')).callMcpTool;
  return call(
    manifest.mcpServers.webflow.url,
    tool,
    {
      actions: [{ label: Object.keys(action)[0], ...action }],
      context:
        'Frink manages site webhook subscriptions so authorized Webflow events can start the automations configured in the connected application.',
    },
    {
      Authorization: `Bearer ${ctx.token}`,
    },
  );
}

async function request<T>(
  caller: McpCaller | undefined,
  ctx: RegistrarContext,
  tool: 'data_sites_tool' | 'data_webhook_tool',
  action: Record<string, Record<string, string | number>>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const response = await invoke(caller, ctx, tool, action);
    if (!response.ok) throw refused(tool);
    const result = toolReply.parse(response.result);
    if (result.isError) throw refused(tool);
    const name = Object.keys(action)[0];
    return z
      .object({
        label: z.literal(name),
        action: z.literal(name),
        result: schema,
      })
      .parse(JSON.parse(result.content[0].text)).result;
  } catch {
    // Tool replies can echo credentials or the private destination URL; never surface their text.
    throw refused(Object.keys(action)[0]);
  }
}

function events(ctx: RegistrarContext): Set<string> {
  return new Set(ctx.provider.events.flatMap((event) => event.vendor_events ?? []));
}

function owns(ctx: RegistrarContext, hook: Webhook): boolean {
  return hook.url === ctx.webhookUrl && events(ctx).has(hook.triggerType);
}

async function listSite(caller: McpCaller | undefined, ctx: RegistrarContext, siteId: string) {
  const result = await request(
    caller,
    ctx,
    'data_webhook_tool',
    {
      list_webhooks: { site_id: siteId },
    },
    webhookList,
  );
  if (result.webhooks.some((hook) => hook.siteId !== siteId)) throw refused('list_webhooks');
  return result.webhooks;
}

/** Read every site before mutating; an incomplete list must never look like an empty inventory. */
async function discover(caller: McpCaller | undefined, ctx: RegistrarContext): Promise<Discovery> {
  const siteIds: string[] = [];
  let total: number | undefined;
  while (true) {
    const { sites, pagination } = await request(
      caller,
      ctx,
      'data_sites_tool',
      {
        list_sites: { limit: 100, offset: siteIds.length, detail: 'summary' },
      },
      siteList,
    );
    const nextOffset = pagination.offset + pagination.returned;
    if (
      pagination.offset !== siteIds.length ||
      pagination.returned !== sites.length ||
      nextOffset > pagination.total ||
      pagination.hasMore !== nextOffset < pagination.total ||
      (pagination.hasMore && sites.length === 0) ||
      (total !== undefined && total !== pagination.total)
    ) {
      throw refused('verify site pagination');
    }
    total = pagination.total;
    siteIds.push(...sites.map((site) => site.id));
    if (!pagination.hasMore) break;
  }
  if (new Set(siteIds).size !== siteIds.length) throw refused('verify site pagination');
  const saved =
    ctx.endpoint.vendor_ref === null
      ? { sites: [], webhooks: [] }
      : parseReferences(ctx.endpoint.vendor_ref);
  const attemptedSites = [
    ...new Set([...siteIds, ...saved.sites, ...saved.webhooks.map((ref) => ref.siteId)]),
  ];
  const hooks: Webhook[] = [];
  for (const siteId of attemptedSites) {
    try {
      hooks.push(...(await listSite(caller, ctx, siteId)));
    } catch {
      // Saved handles may still be readable after a site leaves discovery. Inspect them, but do
      // not declare cleanup complete without the site inventory: a lost create may have no ID.
      for (const ref of saved.webhooks.filter((entry) => entry.siteId === siteId)) {
        await request(
          caller,
          ctx,
          'data_webhook_tool',
          { get_webhook: { webhook_id: ref.webhookId } },
          webhook,
        );
      }
      throw refused('verify previously authorized site');
    }
  }
  return { siteIds, attemptedSites, hooks };
}

function parseReferences(value: string) {
  try {
    return ownedReferences.parse(
      JSON.parse(value.startsWith('pending:') ? value.slice('pending:'.length) : value),
    );
  } catch {
    throw refused('read saved webhook references');
  }
}

async function deleteVerified(caller: McpCaller | undefined, ctx: RegistrarContext, hook: Webhook) {
  // The official tool serializes the SDK's void delete result; some versions send no valid text.
  // Whether its response arrives or not, an authorized list proving absence is the completion test.
  const outcome = await invoke(caller, ctx, 'data_webhook_tool', {
    delete_webhook: { webhook_id: hook.id },
  }).catch(() => null);
  const remaining = await listSite(caller, ctx, hook.siteId);
  if (remaining.some((candidate) => candidate.id === hook.id)) {
    throw refused(outcome?.ok ? 'confirm webhook deletion' : 'delete_webhook');
  }
}

function encodeReferences(sites: string[], hooks: Webhook[]): string {
  return JSON.stringify({
    sites,
    webhooks: hooks.map((hook) => ({ siteId: hook.siteId, webhookId: hook.id })),
  });
}

/** Injectable only at the transport boundary; production uses the existing one-shot MCP client. */
export function createWebflowRegistrar(caller?: McpCaller): TriggerRegistrar {
  return {
    canDiscoverSubscriptions: true,
    manualRemoval: 'Remove the Frink destination from each Webflow site’s Settings → Webhooks.',
    async register(ctx) {
      if (!ctx.saveProgress) throw refused('persist webhook setup progress');
      if (ctx.endpoint.vendor_ref !== null) {
        await ctx.saveProgress(JSON.stringify(parseReferences(ctx.endpoint.vendor_ref)));
      }
      const inventory = await discover(caller, ctx);
      if (inventory.siteIds.length === 0 || events(ctx).size === 0) {
        throw new VendorRequestError(
          'No Webflow sites are available. Create a site in Webflow or reconnect and allow access to an existing site.',
          'no authorized sites or catalog events',
        );
      }
      const owned = inventory.hooks.filter((hook) => owns(ctx, hook));
      await ctx.saveProgress(encodeReferences(inventory.attemptedSites, owned));
      for (const siteId of inventory.siteIds) {
        for (const event of events(ctx)) {
          if (owned.some((hook) => hook.siteId === siteId && hook.triggerType === event)) continue;
          const created = await request(
            caller,
            ctx,
            'data_webhook_tool',
            {
              create_webhook: { site_id: siteId, trigger_type: event, url: ctx.webhookUrl },
            },
            webhook,
          );
          if (created.siteId !== siteId || created.triggerType !== event || !owns(ctx, created)) {
            throw refused('verify created webhook');
          }
          owned.push(created);
          await ctx.saveProgress(encodeReferences(inventory.attemptedSites, owned));
        }
      }
      return {
        vendorRef: encodeReferences(inventory.attemptedSites, owned),
      };
    },
    // Webflow authenticates the destination capability URL, not Frink's separate test-event secret.
    async rotate() {
      return {};
    },
    async remove(ctx) {
      const inventory = await discover(caller, ctx);
      for (const hook of inventory.hooks.filter((candidate) => owns(ctx, candidate))) {
        await deleteVerified(caller, ctx, hook);
      }
    },
  };
}

export const webflowRegistrar = createWebflowRegistrar();
