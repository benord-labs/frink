import { useCallback } from 'react';
import { toast } from 'sonner';
import type { ResolvedPlugin } from '../../../shared/integrations/plugins';
import {
  getProviderById,
  mintsLocally,
  registersLocally,
} from '../../../shared/integrations/selectors';
import { trpc } from '../trpc';
import { plainProblem } from './triggers/delivery-state';
import { isWebhookPluginId } from '../../../shared/integrations/installable-plugins';
import { usePluginRefresh } from './use-plugin-refresh';

export type WebhookEndpointSetup = {
  offered: boolean;
  isPending: boolean;
  create: () => Promise<void>;
};

/** One click mints what a paste_url provider with no account grant needs before its card can show an
 * address: the account-less integration row, then its first endpoint. Offered once, while chat is live. */
export function useWebhookEndpointSetup(
  plugin: ResolvedPlugin | undefined,
  toolsConnected: boolean,
): WebhookEndpointSetup {
  const refresh = usePluginRefresh();
  const connect = trpc.integrations.connectWebhookOnly.useMutation();
  const generate = trpc.integrations.generateWebhookEndpoint.useMutation();
  const id = plugin?.definition.id ?? '';
  const name = plugin?.definition.name ?? '';
  const provider = getProviderById(id);
  const offered =
    plugin !== undefined &&
    // A pasted address needs nothing but this machine; a registrar still needs the vendor grant.
    (mintsLocally(provider) || (registersLocally(provider) && toolsConnected)) &&
    // A webhook-only plugin gets its account from install; every other plugin mints one here.
    !isWebhookPluginId(id) &&
    // Offered until this machine holds a trigger account.
    !plugin.connections.some((connection) => connection.isActive);
  const isPending = connect.isPending || generate.isPending;

  const create = useCallback(async () => {
    if (isPending || id === '') return;
    try {
      const row = await connect.mutateAsync({ provider: id, label: name });
      const endpoint = await generate.mutateAsync({ integrationId: row.integration.id });
      if (!endpoint.success) throw new Error(endpoint.error);
      // The registrar records why it could not arm the vendor on the endpoint row; say it here so
      // the page is not left showing a bare "Not set up".
      const registrationProblem = plainProblem(endpoint.endpoint.lastError, name);
      if (registrationProblem) {
        toast.warning(`Frink couldn't set this up in ${name}`, {
          description: registrationProblem,
        });
      }
    } catch (error) {
      toast.error(`Could not create a ${name} webhook address`, {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      // The row may exist without its endpoint after a failure; the card then offers Generate.
      refresh();
    }
  }, [connect, generate, id, isPending, name, refresh]);

  return { offered, isPending, create };
}
