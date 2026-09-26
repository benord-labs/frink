/** Hugging Face HTTP translation; leases, credentials, rotation and cleanup belong to the shared registrar. */
import { z } from 'zod';
import type { RegistrarContext, TriggerRegistrar } from '../index';
import { TriggerOperationError } from '../operation';
import { VendorRequestError, vendorJson } from '../vendor-http';
import type { JsonValue } from '../../../../../shared/types/permissions';

const API = 'https://huggingface.co/api/settings/webhooks';
const watch = z.object({
  type: z.enum(['user', 'org', 'model', 'dataset', 'space', 'bucket', 'kernel']),
  name: z.string().min(1).max(200),
});
const reference = z.object({ id: z.string().nullable(), watched: z.array(watch).min(1) });
const webhook = z.object({
  id: z.string().min(1),
  url: z.string().optional(),
  watched: z.array(watch),
  domains: z.array(z.string()),
  hasSecret: z.boolean(),
  disabled: z.union([z.boolean(), z.literal('suspended-after-failure')]),
});
type Hook = z.infer<typeof webhook>;
const DOMAINS = ['repo', 'discussion'];

function refused(reason = 'Hugging Face could not confirm webhook setup. Try again.') {
  return new VendorRequestError(reason, 'Hugging Face webhook request failed');
}

async function request<T>(
  token: string,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  schema: z.ZodType<T>,
  json?: JsonValue,
) {
  try {
    return await vendorJson('Hugging Face', API + path, { token, method, json }, schema);
  } catch (error) {
    if (error instanceof TriggerOperationError) throw error;
    // Preserve actionable status, never vendor bodies or schema values (which may contain secrets).
    if (error instanceof VendorRequestError) {
      const reason =
        error.status === 400 || error.status === 422
          ? 'Hugging Face rejected this setup. Check the resource type and enter an existing user, organization, or repository name.'
          : error.reason;
      throw new VendorRequestError(reason, 'Hugging Face webhook request failed', error.status);
    }
    throw refused('Hugging Face returned an unexpected webhook response. Try again.');
  }
}

async function inventory(token: string) {
  const hooks = await request(token, '', 'GET', z.array(webhook));
  if (!hooks) throw refused();
  return hooks;
}

function saved(ctx: RegistrarContext) {
  const ref = ctx.endpoint.vendor_ref;
  if (!ref) return null;
  try {
    return reference.parse(JSON.parse(ref.startsWith('pending:') ? ref.slice(8) : ref));
  } catch {
    throw refused(
      'The saved Hugging Face subscription could not be read. Review it under Advanced.',
    );
  }
}

function selection(ctx: RegistrarContext) {
  const prior = saved(ctx);
  if (!ctx.selection?.length) {
    if (prior) return prior.watched;
    throw refused('Choose what to watch in Hugging Face.');
  }
  const result = z
    .array(watch)
    .min(1)
    .max(100)
    .safeParse(
      ctx.selection.map((value) => {
        const [type, ...name] = value.split(':');
        return { type, name: name.join(':') };
      }),
    );
  if (!result.success) throw refused('Choose a valid Hugging Face watch type and name.');
  return result.data;
}

async function owned(ctx: RegistrarContext): Promise<Hook | null> {
  const hooks = await inventory(ctx.token);
  const id = saved(ctx)?.id;
  if (hooks.some((hook) => hook.id === id && hook.url !== ctx.webhookUrl))
    throw refused(
      'The Hugging Face webhook destination changed. Review it under Advanced before retrying.',
    );
  const matches = hooks.filter((hook) => hook.url === ctx.webhookUrl);
  if (matches.length > 1)
    throw refused('Multiple Hugging Face webhooks use this address. Review them under Advanced.');
  return matches[0] ?? null;
}

function sameSet(actual: string[], expected: string[]) {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}

function configured(hook: Hook, ctx: RegistrarContext, watched: z.infer<typeof watch>[]) {
  return (
    hook.url === ctx.webhookUrl &&
    hook.hasSecret &&
    sameSet(hook.domains, DOMAINS) &&
    sameSet(
      hook.watched.map((item) => JSON.stringify(item)),
      watched.map((item) => JSON.stringify(item)),
    )
  );
}

async function register(ctx: RegistrarContext) {
  if (!ctx.saveProgress) throw refused('Webhook setup could not save its progress. Try again.');
  const watched = selection(ctx);
  let hook = await owned(ctx);
  await ctx.saveProgress(JSON.stringify({ id: hook?.id ?? null, watched }));
  // Secrets are write-only in the vendor API. Reapply ours on reconciliation/rotation;
  // hasSecret proves presence, not that a pre-existing secret matches this endpoint.
  const result = await request(
    ctx.token,
    hook ? '/' + encodeURIComponent(hook.id) : '',
    'POST',
    z.object({ webhook }),
    { url: ctx.webhookUrl, secret: ctx.endpoint.webhook_secret, watched, domains: DOMAINS },
  );
  if (!result)
    throw refused(
      'Hugging Face could not find the watched resource or webhook. Check the resource name and try again.',
    );
  hook = result.webhook;
  await ctx.saveProgress(JSON.stringify({ id: hook.id, watched }));
  if (hook.disabled) {
    const result = await request(
      ctx.token,
      '/' + encodeURIComponent(hook.id) + '/enable',
      'POST',
      z.object({ webhook }),
    );
    if (!result) throw refused();
    hook = result.webhook;
  }
  if (hook.disabled || !configured(hook, ctx, watched)) throw refused();
  return { vendorRef: JSON.stringify({ id: hook.id, watched }) };
}

async function remove(ctx: RegistrarContext) {
  const hook = await owned(ctx);
  if (!hook) return;
  try {
    await request(ctx.token, '/' + encodeURIComponent(hook.id), 'DELETE', z.unknown());
  } catch (error) {
    if (error instanceof TriggerOperationError) throw error;
    // Settle an ambiguous delete using a fresh authorized inventory.
  }
  if (await owned(ctx)) throw refused('Hugging Face has not confirmed webhook removal. Try again.');
}

export const huggingfaceRegistrar: TriggerRegistrar = {
  canDiscoverSubscriptions: true,
  setupOptions: async ({ token }) => {
    await inventory(token);
    return { options: [], selection: 'many' };
  },
  register,
  // Reconcile the saved watch scope and new secret; never send an empty watched list.
  rotate: register,
  remove,
  manualRemoval: 'Delete the subscription in Hugging Face webhook settings.',
};
