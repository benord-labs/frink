/** ClickUp REST subscriptions use a separate personal API key; the official MCP token is not a REST credential. */
import { z } from 'zod';
import type { RegistrarContext, TriggerRegistrar } from '../index';
import { TriggerOperationError } from '../operation';
import { VendorRequestError, vendorJson } from '../vendor-http';
import type { JsonValue } from '../../../../../shared/types/permissions';

const API = 'https://api.clickup.com/api/v2';
const reference = z
  .object({ workspaceId: z.string().min(1), webhookId: z.string().nullable() })
  .strict();
const webhook = z.object({
  id: z.string().min(1),
  team_id: z.union([z.string(), z.number()]).transform(String),
  endpoint: z.string(),
  events: z.array(z.string()),
  secret: z.string().min(1),
  task_id: z.string().nullable(),
  list_id: z.string().nullable(),
  folder_id: z.string().nullable(),
  space_id: z.string().nullable(),
  health: z.object({ status: z.string() }),
});
type Webhook = z.infer<typeof webhook>;

function refused(
  reason = "ClickUp couldn't complete trigger setup. Check its API key and workspace access, then try again.",
) {
  return new VendorRequestError(reason, 'ClickUp subscription request failed');
}

async function request<T>(
  token: string,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  schema: z.ZodType<T>,
  json?: JsonValue,
) {
  try {
    return await vendorJson(
      'ClickUp',
      `${API}${path}`,
      { method, token, authScheme: 'raw', json },
      schema,
    );
  } catch (error) {
    if (error instanceof TriggerOperationError) throw error;
    // Neither vendor bodies nor schema errors may expose the API key, signing secret or destination.
    throw refused();
  }
}

/** Validates the key through ClickUp and returns only user-visible workspace choices. */
export async function getClickupWorkspaces(
  token: string,
): Promise<{ id: string; label: string }[]> {
  const result = await request(
    token,
    '/team',
    'GET',
    z.object({
      teams: z.array(z.object({ id: z.string().min(1), name: z.string() })),
    }),
  );
  if (!result) throw refused();
  return result.teams.map(({ id, name }) => ({ id, label: name }));
}

function saved(ctx: RegistrarContext) {
  const value = ctx.endpoint.vendor_ref;
  if (!value) return null;
  try {
    return reference.parse(JSON.parse(value.startsWith('pending:') ? value.slice(8) : value));
  } catch {
    throw refused(
      'The saved ClickUp subscription could not be read. Check its setup under Advanced.',
    );
  }
}

function events(ctx: RegistrarContext): string[] {
  return [...new Set(ctx.provider.events.flatMap((event) => event.vendor_events ?? []))];
}

async function workspace(ctx: RegistrarContext): Promise<string> {
  const prior = saved(ctx)?.workspaceId;
  const choices =
    ctx.selection ??
    (prior
      ? [prior]
      : ctx.integration.external_workspace_id
        ? [ctx.integration.external_workspace_id]
        : []);
  const available = await getClickupWorkspaces(ctx.token);
  const selected = choices.length === 0 && available.length === 1 ? available[0].id : choices[0];
  if (choices.length > 1 || !selected || !available.some(({ id }) => id === selected)) {
    throw refused('Choose one ClickUp workspace for this trigger.');
  }
  if (prior && prior !== selected)
    throw refused('Remove the existing ClickUp trigger before choosing another workspace.');
  return selected;
}

async function owned(ctx: RegistrarContext, workspaceId: string): Promise<Webhook | null> {
  const result = await request(
    ctx.token,
    `/team/${encodeURIComponent(workspaceId)}/webhook`,
    'GET',
    z.object({ webhooks: z.array(webhook) }),
  );
  if (!result || result.webhooks.some((hook) => hook.team_id !== workspaceId)) throw refused();
  const previous = saved(ctx)?.webhookId;
  const moved = result.webhooks.find(
    (hook) => hook.id === previous && hook.endpoint !== ctx.webhookUrl,
  );
  if (moved)
    throw refused(
      'The ClickUp webhook destination was changed. Review it under Advanced before retrying.',
    );
  const matches = result.webhooks.filter((hook) => hook.endpoint === ctx.webhookUrl);
  if (
    matches.length > 1 ||
    matches.some((hook) => hook.task_id || hook.list_id || hook.folder_id || hook.space_id)
  ) {
    throw refused(
      'Multiple or location-restricted ClickUp webhooks use this destination. Review them under Advanced.',
    );
  }
  return matches[0] ?? null;
}

function encode(workspaceId: string, webhookId: string | null): string {
  return JSON.stringify({ workspaceId, webhookId });
}

async function register(ctx: RegistrarContext) {
  if (!ctx.saveProgress)
    throw refused('ClickUp trigger setup could not save its progress. Try again.');
  const workspaceId = await workspace(ctx);
  // The choice is kept before the first vendor read, so a retry after a failed read needs no second pick.
  await ctx.saveProgress(encode(workspaceId, saved(ctx)?.webhookId ?? null));
  let hook = await owned(ctx, workspaceId);
  const desired = events(ctx);
  if (desired.length === 0) throw refused('No ClickUp trigger events are configured.');
  await ctx.saveProgress(encode(workspaceId, hook?.id ?? null));
  if (
    !hook ||
    hook.health.status !== 'active' ||
    hook.events.length !== desired.length ||
    desired.some((event) => !hook?.events.includes(event))
  ) {
    const result = await request(
      ctx.token,
      hook
        ? `/webhook/${encodeURIComponent(hook.id)}`
        : `/team/${encodeURIComponent(workspaceId)}/webhook`,
      hook ? 'PUT' : 'POST',
      z.object({ webhook }),
      hook
        ? { endpoint: ctx.webhookUrl, events: desired, status: 'active' }
        : { endpoint: ctx.webhookUrl, events: desired },
    );
    if (!result) throw refused();
    hook = result.webhook;
  }
  if (
    hook.team_id !== workspaceId ||
    hook.endpoint !== ctx.webhookUrl ||
    hook.task_id !== null ||
    hook.list_id !== null ||
    hook.folder_id !== null ||
    hook.space_id !== null ||
    hook.health.status !== 'active' ||
    hook.events.length !== desired.length ||
    desired.some((event) => !hook.events.includes(event))
  )
    throw refused();
  await ctx.saveProgress(encode(workspaceId, hook.id));
  return { vendorRef: encode(workspaceId, hook.id), secret: hook.secret };
}

async function remove(ctx: RegistrarContext) {
  const ref = saved(ctx);
  if (!ref) return;
  const hook = await owned(ctx, ref.workspaceId);
  if (!hook) return;
  try {
    await request(ctx.token, `/webhook/${encodeURIComponent(hook.id)}`, 'DELETE', z.object({}));
  } catch (error) {
    if (error instanceof TriggerOperationError) throw error;
    // A lost delete response is settled only by a fresh authorized inventory.
  }
  if (await owned(ctx, ref.workspaceId))
    throw refused('ClickUp has not confirmed removal of this webhook. Try again.');
}

export const clickupRegistrar: TriggerRegistrar = {
  canDiscoverSubscriptions: true,
  issuesSigningSecret: true,
  setupOptions: async ({ token }) => ({
    options: await getClickupWorkspaces(token),
    selection: 'one',
  }),
  manualRemoval:
    'Delete the webhook using the ClickUp API and its webhook ID shown under Advanced.',
  register,
  async rotate(ctx) {
    // ClickUp does not accept a caller-supplied signing secret; recreating rotates its secret.
    await remove(ctx);
    return register(ctx);
  },
  remove,
};
