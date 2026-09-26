/** Hosts the plugins directory, owns webhook creation, and mounts the account dialog. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { getProviderById } from '../../../../shared/integrations/selectors';
import { trpc } from '../../../lib/trpc';
import { PluginsPanel } from '../../plugins';
import { IntegrationDetailDialog } from '../IntegrationDetailDialog';
import type { ConnectedIntegration } from '../types';

type Props = {
  /** Reports whether a plugin's page (which owns the h1) replaces the directory. */
  onDetailChange?: (open: boolean) => void;
};

export function Integrations({ onDetailChange }: Props) {
  const [webhookProvider, setWebhookProvider] = useState<string | null>(null);
  const webhookConnectPending = useRef(false);

  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<ConnectedIntegration | null>(null);

  /** The only route into the account dialog. */
  const openDetailDialog = useCallback((integration: ConnectedIntegration) => {
    setSelectedIntegration(integration);
    setDetailDialogOpen(true);
  }, []);

  const {
    data: integrations,
    isLoading,
    refetch: refetchIntegrations,
  } = trpc.integrations.list.useQuery();
  const utils = trpc.useUtils();

  /** The directory stays mounted through a connect, so `plugins.list` is invalidated too: without it a connected plugin keeps offering Connect. */
  const refetch = useCallback(async () => {
    await Promise.all([
      refetchIntegrations(),
      utils.plugins.list.invalidate(),
      // Plugin Flow nodes are derived from connection state: a landed grant adds them.
      utils.customNodes.list.invalidate(),
    ]);
  }, [refetchIntegrations, utils]);

  const installWebhook = trpc.plugins.install.useMutation();

  /**
   * Deliberately unfiltered by launch flag: the directory lists a gated
   * provider's real account as clickable — the only route to disconnecting it.
   */
  const connectedIntegrations: ConnectedIntegration[] = useMemo(() => {
    if (!integrations) return [];
    return integrations.map((i) => ({
      id: i.id,
      provider: i.provider as ConnectedIntegration['provider'],
      accountName: i.accountName || '',
      accountIdentifier: i.accountIdentifier,
    }));
  }, [integrations]);

  useEffect(() => {
    if (!selectedIntegration) return;
    const refreshed = connectedIntegrations.find((item) => item.id === selectedIntegration.id);
    if (refreshed) {
      setSelectedIntegration(refreshed);
      return;
    }
    setSelectedIntegration(null);
    setDetailDialogOpen(false);
  }, [connectedIntegrations, selectedIntegration]);

  /**
   * The plugin page lists accounts from `plugins.list` while this resolves them
   * against `integrations.list` — two queries refetched independently, so a
   * stale id is reachable and used to fail as a dead click. Since the page
   * became the only route to disconnecting an account, a silent miss would
   * strand the user, so it refetches and says so.
   */
  const handleAccountSelect = useCallback(
    (connectionId: string) => {
      const account = connectedIntegrations.find((row) => row.id === connectionId);
      if (account) return openDetailDialog(account);
      refetchIntegrations();
      toast.error('That account is no longer available', {
        description: 'The list has been refreshed.',
      });
    },
    [connectedIntegrations, openDetailDialog, refetchIntegrations],
  );

  /** Create the webhook account for a plugin; every provider connects this way. */
  const handlePluginConnect = useCallback(
    async (pluginId: string) => {
      const provider = getProviderById(pluginId);
      if (!provider || webhookConnectPending.current) return;
      webhookConnectPending.current = true;
      setWebhookProvider(provider.id);
      let created = false;
      try {
        await installWebhook.mutateAsync({ pluginId: provider.id });
        created = true;
      } catch (error) {
        toast.error(`Could not finish connecting ${provider.display_name}`, {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      }
      // A failed endpoint setup can still have created the installation and account.
      try {
        await refetch();
      } catch (error) {
        toast.error(
          created
            ? 'Connection created, but the list could not refresh.'
            : 'Could not refresh connections.',
          {
            description: error instanceof Error ? error.message : 'Please try again.',
          },
        );
      } finally {
        webhookConnectPending.current = false;
        setWebhookProvider(null);
      }
    },
    [installWebhook, refetch],
  );

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <>
      <PluginsPanel
        onDetailChange={onDetailChange}
        connectingProvider={webhookProvider}
        // The panel leaves a plugin page the open account dialog does not belong to.
        accountDialogProvider={detailDialogOpen ? (selectedIntegration?.provider ?? null) : null}
        onConnect={handlePluginConnect}
        onSelectAccount={handleAccountSelect}
      />

      <IntegrationDetailDialog
        integration={selectedIntegration}
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
        onDisconnected={() => refetch()}
        onRefetch={() => refetch()}
      />
    </>
  );
}
