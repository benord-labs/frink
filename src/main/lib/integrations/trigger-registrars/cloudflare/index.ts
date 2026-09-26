/** Frink-owned copies preserve the user's alert conditions and leave existing recipients alone. */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { RegistrarContext, TriggerRegistrar } from '../index';
import { VendorRequestError } from '../vendor-http';
import {
  accountPath,
  accounts,
  eligible,
  identifier,
  listDestinations,
  listPolicies,
  request,
  resultSchema,
  successSchema,
  refused,
  type McpCaller,
  type Policy,
} from './api';

const savedSchema = z
  .object({
    account: identifier,
    sources: z.array(identifier).min(1),
    destinations: z.array(identifier),
    policies: z.array(identifier),
  })
  .strict();
type Saved = z.infer<typeof savedSchema>;
const PREFIX = 'Frink Flow ';
const marker = (ctx: RegistrarContext) => `${PREFIX}${ctx.endpoint.id}`;
const policyName = (ctx: RegistrarContext, source: string) => `${marker(ctx)} ${source}`;
const encodeSelection = (account: string, source: string) => `${account}:${source}`;
// Frink's own copies carry the prefix in BOTH fields, so a user alert merely named
// "Frink Flow ..." is still offered as a source.
const isFrinkCopy = (policy: Policy) =>
  policy.name.startsWith(PREFIX) && (policy.description ?? '').startsWith(PREFIX);

function readSaved(ctx: RegistrarContext): Saved | undefined {
  if (!ctx.endpoint.vendor_ref) return undefined;
  try {
    return savedSchema.parse(JSON.parse(ctx.endpoint.vendor_ref.replace(/^pending:/, '')));
  } catch {
    throw refused('read saved notification references');
  }
}

function choose(ctx: RegistrarContext, previous: Saved | undefined): Saved {
  const selected =
    ctx.selection ?? previous?.sources.map((id) => encodeSelection(previous.account, id));
  if (!selected?.length)
    throw new VendorRequestError(
      'Choose the Cloudflare alerts that should start your Flows.',
      'notification selection required',
    );
  const pairs = selected.map((value) => z.tuple([identifier, identifier]).parse(value.split(':')));
  const account = pairs[0][0];
  const sources = [...new Set(pairs.map(([, id]) => id))];
  if (pairs.some(([id]) => id !== account))
    throw new VendorRequestError(
      'Choose alerts from one Cloudflare account.',
      'multiple notification accounts selected',
    );
  if (
    previous &&
    (previous.account !== account ||
      previous.sources.some((id) => !sources.includes(id)) ||
      sources.some((id) => !previous.sources.includes(id)))
  ) {
    throw new VendorRequestError(
      'Remove the current trigger setup before choosing different alerts.',
      'notification scope changed before cleanup',
    );
  }
  return previous ?? { account, sources, destinations: [], policies: [] };
}

function policyBody(ctx: RegistrarContext, source: Policy, destination: string) {
  const body: Omit<Policy, 'id'> = {
    name: policyName(ctx, source.id),
    description: marker(ctx),
    enabled: true,
    alert_type: source.alert_type,
    mechanisms: { webhooks: [{ id: destination }] },
  };
  if (source.alert_interval !== undefined) body.alert_interval = source.alert_interval;
  if (source.filters !== undefined) body.filters = source.filters;
  return body;
}

async function inventory(caller: McpCaller | undefined, ctx: RegistrarContext, saved: Saved) {
  const destinations = (await listDestinations(caller, ctx.token, saved.account)).filter(
    (item) => item.name === marker(ctx) && item.url === ctx.webhookUrl,
  );
  const policies = await listPolicies(caller, ctx.token, saved.account);
  const owned = policies.filter(
    (item) =>
      item.description === marker(ctx) &&
      saved.sources.some((id) => item.name === policyName(ctx, id)),
  );
  // Previously recorded IDs must still have their ownership evidence or be absent. Never delete
  // a resource that somebody has repurposed since Frink created it.
  if (saved.destinations.some((id) => !destinations.some((item) => item.id === id))) {
    const all = await listDestinations(caller, ctx.token, saved.account);
    if (
      all.some(
        (item) =>
          saved.destinations.includes(item.id) && !destinations.some((own) => own.id === item.id),
      )
    )
      throw refused('verify destination ownership');
  }
  if (
    policies.some(
      (item) => saved.policies.includes(item.id) && !owned.some((own) => own.id === item.id),
    )
  )
    throw refused('verify policy ownership');
  return { destinations, policies, owned };
}

async function save(ctx: RegistrarContext, saved: Saved) {
  if (!ctx.saveProgress) throw refused('persist notification setup progress');
  await ctx.saveProgress(JSON.stringify(saved));
}

/** Injectable transport exercises the real request/response and lifecycle contracts. */
export function createCloudflareRegistrar(caller?: McpCaller): TriggerRegistrar {
  return {
    canDiscoverSubscriptions: true,
    manualRemoval:
      'In Cloudflare Notifications, remove the Frink Flow policies, then their Frink Flow destination.',
    async setupOptions({ token }) {
      const options: { id: string; label: string; description?: string }[] = [];
      let eligibleAccounts = 0;
      for (const account of await accounts(caller, token)) {
        if (!(await eligible(caller, token, account.id))) continue;
        eligibleAccounts++;
        for (const policy of await listPolicies(caller, token, account.id)) {
          if (!policy.enabled || isFrinkCopy(policy)) continue;
          options.push({
            id: encodeSelection(account.id, policy.id),
            label: `${account.name} · ${policy.name}`,
          });
        }
      }
      if (!eligibleAccounts)
        throw new VendorRequestError(
          'This Cloudflare account cannot send webhook notifications. Cloudflare requires an eligible paid plan.',
          'no eligible webhook delivery accounts',
        );
      if (!options.length)
        throw new VendorRequestError(
          'Create an alert in Cloudflare Notifications, then try again.',
          'no enabled notification policies',
        );
      return { options, selection: 'many' };
    },
    async register(ctx) {
      const saved = choose(ctx, readSaved(ctx));
      if (!(await eligible(caller, ctx.token, saved.account)))
        throw new VendorRequestError(
          'Cloudflare webhook notifications are not available on this account.',
          'selected account ineligible',
        );
      let found = await inventory(caller, ctx, saved);
      const sources = saved.sources.map((id) =>
        found.policies.find((policy) => policy.id === id && policy.enabled && !isFrinkCopy(policy)),
      );
      if (sources.some((source) => !source))
        throw new VendorRequestError(
          'An alert is no longer available. Enable it in Cloudflare and try again.',
          'selected policy absent or disabled',
        );
      saved.destinations = found.destinations.map(({ id }) => id);
      saved.policies = found.owned.map(({ id }) => id);
      await save(ctx, saved); // Scope survives a lost create response or an interrupted process.
      if (found.destinations.length > 1) throw refused('ambiguous destination ownership');
      if (!found.destinations.length) {
        await request(
          caller,
          ctx.token,
          {
            method: 'POST',
            path: `${accountPath(saved.account)}/destinations/webhooks`,
            body: { name: marker(ctx), url: ctx.webhookUrl, secret: ctx.endpoint.webhook_secret },
          },
          resultSchema(z.object({ id: identifier })),
          saved.account,
        );
        found = await inventory(caller, ctx, saved);
        if (found.destinations.length !== 1) throw refused('verify created destination');
      }
      const destination = found.destinations[0].id;
      saved.destinations = [destination];
      await save(ctx, saved);
      // Reset the secret even after a lost create response; Cloudflare never returns its value.
      await request(
        caller,
        ctx.token,
        {
          method: 'PUT',
          path: `${accountPath(saved.account)}/destinations/webhooks/${destination}`,
          body: { name: marker(ctx), url: ctx.webhookUrl, secret: ctx.endpoint.webhook_secret },
        },
        successSchema,
        saved.account,
      );
      for (const source of sources) {
        if (!source) throw refused('selected policy');
        const matches = found.owned.filter((item) => item.name === policyName(ctx, source.id));
        if (matches.length > 1) throw refused('ambiguous policy ownership');
        const body = policyBody(ctx, source, destination);
        await request(
          caller,
          ctx.token,
          {
            method: matches.length ? 'PUT' : 'POST',
            path: `${accountPath(saved.account)}/policies${matches.length ? `/${matches[0].id}` : ''}`,
            body,
          },
          successSchema,
          saved.account,
        );
        found = await inventory(caller, ctx, saved);
        const verified = found.owned.filter((item) => item.name === body.name);
        if (
          verified.length !== 1 ||
          !verified[0].enabled ||
          verified[0].alert_type !== body.alert_type ||
          !isDeepStrictEqual(verified[0].filters ?? {}, body.filters ?? {}) ||
          verified[0].alert_interval !== body.alert_interval ||
          verified[0].mechanisms.webhooks?.length !== 1 ||
          verified[0].mechanisms.webhooks[0].id !== destination ||
          verified[0].mechanisms.email?.length ||
          verified[0].mechanisms.pagerduty?.length
        )
          throw refused('verify copied policy');
        saved.policies = found.owned.map(({ id }) => id);
        await save(ctx, saved);
      }
      return { vendorRef: JSON.stringify(saved) };
    },
    async rotate(ctx) {
      const saved = readSaved(ctx);
      if (!saved) throw refused('read saved notification references');
      const found = await inventory(caller, ctx, saved);
      if (found.destinations.length !== 1) throw refused('find destination');
      await request(
        caller,
        ctx.token,
        {
          method: 'PUT',
          path: `${accountPath(saved.account)}/destinations/webhooks/${found.destinations[0].id}`,
          body: { name: marker(ctx), url: ctx.webhookUrl, secret: ctx.endpoint.webhook_secret },
        },
        successSchema,
        saved.account,
      );
      return {};
    },
    async remove(ctx) {
      const saved = readSaved(ctx);
      if (!saved) return;
      const found = await inventory(caller, ctx, saved);
      for (const policy of found.owned) {
        await request(
          caller,
          ctx.token,
          { method: 'DELETE', path: `${accountPath(saved.account)}/policies/${policy.id}` },
          successSchema,
          saved.account,
        ).catch(() => undefined);
        if (
          (await listPolicies(caller, ctx.token, saved.account)).some(({ id }) => id === policy.id)
        )
          throw refused('confirm policy deletion');
      }
      const remainingPolicies = await listPolicies(caller, ctx.token, saved.account);
      for (const destination of found.destinations) {
        if (
          remainingPolicies.some((policy) =>
            policy.mechanisms.webhooks?.some(({ id }) => id === destination.id),
          )
        ) {
          throw new VendorRequestError(
            'Another Cloudflare alert uses the Frink destination. Remove that destination from the alert before disconnecting.',
            'destination referenced by an unowned policy',
          );
        }
        await request(
          caller,
          ctx.token,
          {
            method: 'DELETE',
            path: `${accountPath(saved.account)}/destinations/webhooks/${destination.id}`,
          },
          successSchema,
          saved.account,
        ).catch(() => undefined);
        if (
          (await listDestinations(caller, ctx.token, saved.account)).some(
            ({ id }) => id === destination.id,
          )
        )
          throw refused('confirm destination deletion');
      }
    },
  };
}

export const cloudflareRegistrar = createCloudflareRegistrar();
