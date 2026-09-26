/** The trigger card's procedures. Every entry point answers `null` when the id names no account on
 * this machine, and the router turns that into the card's "not on this machine" line. */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { isWebhookPluginId } from '../../../../shared/integrations/installable-plugins';
import { PROVIDERS } from '../../../../shared/integrations/providers';
import { getProviderById, servedLocally } from '../../../../shared/integrations/selectors';
import type { Provider } from '../../../../shared/integrations/types';
import { ensureLocalAccountIdentity } from '../../integrations/plugin-mcp-lifecycle/account-identity';
import {
  withConnectionLifecycleOperation,
  withPluginLifecycleOperation,
} from '../../integrations/connection-lifecycle-operation';
import {
  disconnectWebhookConnection,
  forgetHeldAccount,
} from '../../integrations/plugin-webhook-lifecycle';
import type {
  RegistrationResult,
  TriggerSetupOptions,
} from '../../integrations/trigger-registrars';
import { VendorRequestError } from '../../integrations/trigger-registrars/vendor-http';
import {
  confirmLocalNotion,
  createLocalTriggerAccount,
  deactivateLocalEndpoint,
  importLocalVendorSecret,
  importLocalVendorWebhook,
  listLocalEndpoints,
  type LocalEndpointIo,
  localEndpointIo,
  localAccountIdentifier,
  localEndpointView,
  type LocalOutcome,
  localRegistrar,
  localTriggerAccount,
  localTriggerOptions,
  mintLocalEndpoint,
  registerLocalTrigger,
  removeLocalTrigger,
  removeLocalTriggersForAccount,
  restartLocalNotion,
  retryLocalTrigger,
  rotateLocalEndpoint,
  rotateLocalTrigger,
  sendLocalTestEvent,
} from '../../webhooks';
import { readSealedSecret } from '../../webhooks/deps';
import { publicProcedure } from '../index';
import { getByPluginId } from '../../db/repos/plugin-installations';
import { findWebhookEndpoint, type LocalIntegrationRow } from '../../db/repos/webhook-ingress';

export const ACCOUNT_MISSING = 'This trigger account is not on this machine.';
const NOT_AUTOMATIC = 'This plugin does not support automatic setup.';
const ENDPOINT_MISSING = 'Active trigger not found.';
const PLUGIN_OFF = 'Turn the plugin on before trying again.';

export type EndpointInput = { integrationId: string; webhookId: string };

/**
 * Ids minted on this machine are opaque text, so every endpoint input is a trimmed non-empty
 * string (`project-id-opaque-text-validation`, `flow-id-type-local-cuid2`), never a UUID.
 */
export function localIdField() {
  return z.string().trim().min(1);
}

type LocalContext = { io: LocalEndpointIo; account: LocalIntegrationRow };

/** The local account an id names, or null when this is a hosted-class account. */
async function localContext(integrationId: string): Promise<LocalContext | null> {
  const io = localEndpointIo();
  const account = await localTriggerAccount(io, integrationId);
  return account ? { io, account } : null;
}

/** A local account whose class this machine registers at the vendor itself. */
async function localAutoContext(integrationId: string): Promise<LocalContext | null> {
  const local = await localContext(integrationId);
  if (!local) return null;
  if (!localRegistrar(local.account))
    throw new TRPCError({ code: 'BAD_REQUEST', message: NOT_AUTOMATIC });
  return local;
}

function registered(result: RegistrationResult) {
  if (!result.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason });
  return { success: true as const };
}

/** A registrar writes the row itself, so the card's copy of it is re-read after every attempt. */
async function withRegistration(
  local: LocalContext,
  webhookId: string,
  attempt: Promise<RegistrationResult>,
) {
  const registration = await attempt;
  const view = await localEndpointView(local.io, local.account, webhookId);
  return view.success ? { ...view, registration } : view;
}

export async function localList(integrationId: string) {
  const local = await localContext(integrationId);
  if (!local) return null;
  return {
    success: true as const,
    singleEndpoint: false,
    endpoints: await listLocalEndpoints(local.io, local.account),
  };
}

/** Every action that arms an address at a vendor shares the plugin's lifecycle lock with Remove and
 * Turn off, so nothing is minted or registered under a plugin that is being taken down. */
export async function localGenerate(integrationId: string, limit: number) {
  const local = await localContext(integrationId);
  if (!local) return null;
  return withPluginLifecycleOperation(local.account.provider, async () => {
    const minted = await mintLocalEndpoint(local.io, local.account, limit);
    if (!minted.success || !localRegistrar(local.account)) return minted;
    return withRegistration(
      local,
      minted.endpoint.id,
      registerLocalTrigger(local.io, local.account, minted.endpoint.id),
    );
  });
}

export async function localRotate(integrationId: string, webhookId: string) {
  const local = await localContext(integrationId);
  if (!local) return null;
  return withPluginLifecycleOperation(local.account.provider, () =>
    localRegistrar(local.account)
      ? withRegistration(local, webhookId, rotateLocalTrigger(local.io, local.account, webhookId))
      : rotateLocalEndpoint(local.io, local.account, webhookId),
  );
}

export async function localDeactivate(integrationId: string, webhookId: string) {
  const local = await localContext(integrationId);
  if (!local) return null;
  if (localRegistrar(local.account)) {
    // The leased remove deactivates the row in the same write; a refusal leaves it live to retry.
    const cleanup = await removeLocalTrigger(local.io, local.account, webhookId);
    if (!cleanup.ok) return { success: false as const, error: cleanup.reason };
    return localEndpointView(local.io, local.account, webhookId);
  }
  return deactivateLocalEndpoint(local.io, local.account, webhookId);
}

/** The vendor's own setup choices, read with the credential this machine holds. */
export async function localOptions(integrationId: string) {
  const local = await localAutoContext(integrationId);
  if (!local) return null;
  try {
    return await localTriggerOptions(local.account);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: error instanceof VendorRequestError ? error.reason : String(error),
    });
  }
}

export async function localConfigure(input: EndpointInput & { selection: string[] }) {
  const local = await localAutoContext(input.integrationId);
  if (!local) return null;
  return withPluginLifecycleOperation(local.account.provider, async () =>
    registered(
      await registerLocalTrigger(local.io, local.account, input.webhookId, {
        selection: input.selection,
      }),
    ),
  );
}

/** The key this setup runs with: the one just typed, else the one the account already holds. */
function apiTokenForSetup(
  provider: Provider,
  vendorRef: string | null,
  storedToken: string | null,
  typedKey: string | undefined,
): string {
  const spec = provider.registrar;
  if (!spec || spec.credential !== 'api_token' || !spec.tokenSetup)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This plugin does not use API-token trigger setup.',
    });
  if (vendorRef?.startsWith('manual:'))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Remove the existing manual trigger before automatic setup.',
    });
  const token = typedKey || storedToken || '';
  if (!token)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Enter your ${provider.display_name} ${spec.tokenSetup.label} to set up triggers automatically.`,
    });
  return token;
}

/**
 * The API-key setup: a usable key, then exactly one resource it can reach.
 * Returns the choices instead when the user still has to pick one.
 */
async function apiTokenSelection(
  provider: Provider,
  vendorRef: string | null,
  storedToken: string | null,
  input: { apiKey?: string; selection?: string[] },
  choicesFor: (token: string) => Promise<TriggerSetupOptions>,
): Promise<{ token: string; selection: string[] } | { options: TriggerSetupOptions['options'] }> {
  const token = apiTokenForSetup(provider, vendorRef, storedToken, input.apiKey);
  let choices: TriggerSetupOptions;
  try {
    // Validate access before binding the credential permanently to this account.
    choices = await choicesFor(token);
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Could not read ${provider.display_name} webhook settings. Check your credential and try again.`,
    });
  }
  const selection =
    input.selection ?? (choices.options.length === 1 ? [choices.options[0].id] : undefined);
  if (!selection) return { options: choices.options };
  if (
    selection.length !== 1 ||
    selection.some((id) => !choices.options.some((option) => option.id === id))
  )
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Choose a resource this API key can access.',
    });
  return { token, selection };
}

export async function localConfigureApiToken(
  input: EndpointInput & { apiKey?: string; selection?: string[] },
) {
  const local = await localAutoContext(input.integrationId);
  if (!local) return null;
  const provider = getProviderById(local.account.provider);
  const row = await findWebhookEndpoint(local.io.db, local.account.id, input.webhookId);
  if (!provider || !row) throw new TRPCError({ code: 'NOT_FOUND', message: ENDPOINT_MISSING });
  const sealed = local.account.apiTokenEncrypted;
  const resolved = await apiTokenSelection(
    provider,
    row.vendorRef,
    sealed ? readSealedSecret(local.io, sealed) : null,
    input,
    (token) => localTriggerOptions(local.account, token),
  );
  if ('options' in resolved) return { success: false as const, options: resolved.options };
  return withPluginLifecycleOperation(local.account.provider, async () => ({
    ...registered(
      await registerLocalTrigger(local.io, local.account, input.webhookId, {
        selection: resolved.selection,
        apiToken: resolved.token,
      }),
    ),
    options: [],
  }));
}

/** A ClickUp webhook the user made by hand: its handle and its key land in one write. */
export async function localImportClickup(
  input: EndpointInput & { vendorWebhookId: string; secret: string },
) {
  const local = await localAutoContext(input.integrationId);
  if (!local) return null;
  if (local.account.provider !== 'clickup') throw new TRPCError({ code: 'BAD_REQUEST' });
  return withPluginLifecycleOperation(local.account.provider, async () =>
    registered(
      await importLocalVendorWebhook(
        local.io,
        local.account,
        input.webhookId,
        `manual:clickup:${input.vendorWebhookId}`,
        input.secret,
      ),
    ),
  );
}

/** Try the vendor again for a row whose registration never completed. */
export async function localRetry(input: EndpointInput) {
  const local = await localAutoContext(input.integrationId);
  if (!local) return null;
  // Under the plugin's lock, as the hosted retry was: Turn off cannot land between the check and the vendor call.
  return withPluginLifecycleOperation(local.account.provider, async () => {
    const installation = await getByPluginId(local.io.db, local.account.provider);
    if (!installation?.isInstalled || !installation.isEnabled)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: PLUGIN_OFF });
    return registered(await retryLocalTrigger(local.io, local.account, input.webhookId));
  });
}

/** Forgets an account this machine holds; a webhook-only plugin's last account takes the plugin with it. */
export async function localDisconnect(integrationId: string) {
  const local = await localContext(integrationId);
  if (!local) return null;
  const { provider } = local.account;
  if (isWebhookPluginId(provider))
    return disconnectWebhookConnection(local.io.db, provider, integrationId);
  // Held under the plugin's lock, then the account's, so no mint lands between the vendor sweep
  // and the delete; an account registered at the vendor is removed there first, or Disconnect stops.
  return withPluginLifecycleOperation(provider, () =>
    withConnectionLifecycleOperation(integrationId, async () => {
      if (localRegistrar(local.account)) {
        const cleanup = await removeLocalTriggersForAccount(local.io, local.account);
        if (!cleanup.ok)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: cleanup.reason });
      }
      await forgetHeldAccount(local.io.db, provider, integrationId);
      return { success: true as const, cleanupPending: false as const };
    }),
  );
}

/** The setup procedures signal failure by throwing, so the card's error line renders either way. */
function orThrow(outcome: LocalOutcome | null): LocalOutcome | null {
  if (outcome && !outcome.success)
    throw new TRPCError({ code: 'BAD_REQUEST', message: outcome.error });
  return outcome;
}

export async function localImportVendorSecret(input: {
  integrationId: string;
  webhookId: string;
  secret: string;
}) {
  const local = await localContext(input.integrationId);
  return orThrow(
    local &&
      (await importLocalVendorSecret(local.io, local.account, input.webhookId, input.secret)),
  );
}

export async function localConfirmNotion(input: {
  integrationId: string;
  webhookId: string;
  generation: string;
  candidate: string;
}) {
  const local = await localContext(input.integrationId);
  return orThrow(
    local &&
      (await confirmLocalNotion(
        local.io,
        local.account,
        input.webhookId,
        input.generation,
        input.candidate,
      )),
  );
}

export async function localRestartNotion(input: {
  integrationId: string;
  webhookId: string;
  generation: string;
  candidate: string | null;
}) {
  const local = await localContext(input.integrationId);
  return orThrow(
    local &&
      (await restartLocalNotion(
        local.io,
        local.account,
        input.webhookId,
        input.generation,
        input.candidate,
      )),
  );
}

/** Every provider this machine can serve, whatever its chat auth: a Linear address is minted here too. */
// SAFETY: the catalog ships several served providers, so this is the non-empty tuple z.enum demands.
const LOCAL_TRIGGER_PROVIDERS = PROVIDERS.filter(servedLocally).map((provider) => provider.id) as [
  string,
  ...string[],
];

const connectInput = z.object({
  provider: z
    .enum(LOCAL_TRIGGER_PROVIDERS)
    .refine((id) => !isWebhookPluginId(id), 'Use plugin installation for a webhook-only plugin.'),
  label: z.string().trim().min(1).max(100),
});

const testInput = z.object({
  integrationId: localIdField(),
  endpointId: localIdField(),
  eventId: z.string().min(1),
});

/** The two procedures whose whole body differs by class, rather than dispatching inside one. */
export function createLocalTriggerProcedures() {
  return {
    /** Optional trigger account beside an MCP plugin's tools grant; plain webhook plugins use plugins.install. */
    connectWebhookOnly: publicProcedure.input(connectInput).mutation(({ input }) =>
      // Under the plugin's lock, as every other account write is, so the identity stamp lands on a
      // settled row and a concurrent Remove cannot slip between the insert and the stamp.
      withPluginLifecycleOperation(input.provider, async () => {
        const io = localEndpointIo();
        const id = await createLocalTriggerAccount(io, input.provider);
        await ensureLocalAccountIdentity(io.db, input.provider, id);
        return {
          success: true as const,
          integration: {
            id,
            provider: input.provider,
            accountIdentifier: localAccountIdentifier(input.provider),
          },
        };
      }),
    ),

    testWebhookEndpoint: publicProcedure.input(testInput).mutation(async ({ input }) => {
      const local = await localContext(input.integrationId);
      if (!local) return { success: false as const, error: 'Active trigger not found.' };
      return sendLocalTestEvent(local.io, local.account, input.endpointId, input.eventId);
    }),
  };
}
