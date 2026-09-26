import { useCallback } from 'react';
import { type ParseEntry, parse } from 'shell-quote';
import { toast } from 'sonner';
import { trpc } from '../lib/trpc';

function parseMcpArgs(rawArgs: string): string[] {
  const parsedArgs = parse(rawArgs);
  return parsedArgs
    .map((entry: ParseEntry): string => {
      if (typeof entry === 'string') {
        return entry;
      }
      if ('pattern' in entry && typeof entry.pattern === 'string') {
        return entry.pattern;
      }
      if ('op' in entry && typeof entry.op === 'string') {
        return entry.op;
      }
      return '';
    })
    .filter(Boolean);
}

/**
 * Refetch every query that reflects MCP server state. Called after any mutation
 * that can change server config, credentials, or enabled state.
 */
async function invalidateMcpQueries(utils: ReturnType<typeof trpc.useUtils>): Promise<void> {
  await Promise.all([
    utils.mcp.getAggregatedMcpInfo.invalidate(),
    utils.mcp.listGlobalServers.invalidate(),
    utils.claude.getAllMcpConfig.invalidate(),
  ]);
}

export function useMcpHandlers(
  setReconnectingServer: (server: string | null) => void,
  configureDialogServerName: string,
) {
  const utils = trpc.useUtils();
  const addMcpMutation = trpc.mcp.setGlobalServer.useMutation();
  const setCredentialsMutation = trpc.mcp.setCredentials.useMutation();
  const removeServerMutation = trpc.mcp.removeGlobalServer.useMutation();
  const toggleEnabledMutation = trpc.mcp.toggleEnabled.useMutation();
  const runImporterMutation = trpc.mcp.runImporter.useMutation();

  // Refresh = re-run the native importer (picks up MCPs added between boots)
  // + invalidate read queries. The importer broadcasts `mcp:imported`, but
  // the originating renderer's `useMcpImportInvalidation` listener may not
  // mount fast enough to catch its own broadcast — we invalidate locally
  // here as well so Refresh always reconciles immediately.
  // Guard against concurrent invocation: the Header button disables on
  // `isRefreshing`, but keyboard shortcuts / programmatic calls can still
  // re-enter. The importer itself has a mutex, so the second call would just
  // wait — but we'd issue duplicate `invalidate()` cascades. Cheap to skip.
  const handleRefresh = useCallback(async () => {
    if (runImporterMutation.isPending) return;
    try {
      await runImporterMutation.mutateAsync();
      await invalidateMcpQueries(utils);
      toast.success('Checked for new servers');
    } catch {
      toast.error("Couldn't check for new servers");
    }
  }, [runImporterMutation, utils]);

  const handleAddMcp = useCallback(
    async (data: {
      name: string;
      command: string;
      args: string;
      envVars: Record<string, string>;
    }) => {
      try {
        // Add the server config.
        await addMcpMutation.mutateAsync({
          name: data.name,
          config: {
            name: data.name,
            type: 'custom',
            authType: Object.keys(data.envVars).length > 0 ? 'env_var' : 'none',
            command: data.command,
            args: parseMcpArgs(data.args),
            requiredEnvVars: Object.keys(data.envVars),
          },
        });

        // Save credentials if provided.
        if (Object.keys(data.envVars).length > 0) {
          await setCredentialsMutation.mutateAsync({
            serverName: data.name,
            credentials: { env: data.envVars },
          });
        }

        toast.success(`Added ${data.name}`);
      } catch (error) {
        toast.error(
          `Failed to add ${data.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        throw error;
      } finally {
        await invalidateMcpQueries(utils);
      }
    },
    [addMcpMutation, setCredentialsMutation, utils],
  );

  const handleSaveCredentials = useCallback(
    async (creds: { env?: Record<string, string>; headers?: Record<string, string> }) => {
      await setCredentialsMutation.mutateAsync({
        serverName: configureDialogServerName,
        credentials: creds,
      });
      await invalidateMcpQueries(utils);
    },
    [setCredentialsMutation, configureDialogServerName, utils],
  );

  const handleDelete = useCallback(
    async (serverName: string) => {
      if (!confirm(`Remove ${serverName}?`)) return;
      const previousMcpInfo = utils.mcp.getAggregatedMcpInfo.getData();
      try {
        // Cancel in-flight refetches before optimistic cache writes.
        await utils.mcp.getAggregatedMcpInfo.cancel();

        utils.mcp.getAggregatedMcpInfo.setData(undefined, (current) => {
          if (!current) return current;
          return current.filter((mcp) => mcp.name !== serverName);
        });

        await removeServerMutation.mutateAsync({ name: serverName });
        toast.success(`Removed ${serverName}`);
      } catch (error) {
        // Roll back optimistic UI state if backend delete fails.
        utils.mcp.getAggregatedMcpInfo.setData(undefined, previousMcpInfo);
        toast.error(
          `Failed to remove ${serverName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      } finally {
        // Reconcile with backend truth after optimistic update.
        await invalidateMcpQueries(utils);
      }
    },
    [removeServerMutation, utils],
  );

  const handleReconnect = useCallback(
    async (serverName: string) => {
      setReconnectingServer(serverName);
      try {
        // Refetch MCP info
        const result = await utils.mcp.getAggregatedMcpInfo.fetch();

        // Find the MCP and check if it's now connected
        const mcp = result?.find((m) => m.name === serverName);

        if (mcp?.status === 'connected') {
          toast.success(`Reconnected to ${serverName}`);
        } else if (mcp?.status === 'needs_auth') {
          toast.error(`${serverName} requires authentication`);
        } else {
          toast.error(`Failed to connect to ${serverName}`);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Failed to reconnect to ${serverName}`;
        toast.error(message);
      } finally {
        setReconnectingServer(null);
      }
    },
    [utils, setReconnectingServer],
  );

  const handleToggleEnabled = useCallback(
    async (serverName: string, currentlyEnabled: boolean) => {
      const nextEnabled = !currentlyEnabled;
      const previousMcpInfo = utils.mcp.getAggregatedMcpInfo.getData();

      try {
        // Cancel any in-flight refetch before writing optimistic cache state.
        await utils.mcp.getAggregatedMcpInfo.cancel();

        utils.mcp.getAggregatedMcpInfo.setData(undefined, (current) => {
          if (!current) return current;

          return current.map((mcp) =>
            mcp.name === serverName
              ? {
                  ...mcp,
                  config: {
                    ...mcp.config,
                    enabled: nextEnabled,
                  },
                }
              : mcp,
          );
        });

        await toggleEnabledMutation.mutateAsync({ name: serverName, enabled: nextEnabled });
        toast.success(currentlyEnabled ? `Turned off ${serverName}` : `Turned on ${serverName}`);
      } catch (error) {
        // Roll back optimistic UI state if backend toggle fails.
        utils.mcp.getAggregatedMcpInfo.setData(undefined, previousMcpInfo);
        toast.error(
          `Couldn't turn ${currentlyEnabled ? 'off' : 'on'} ${serverName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      } finally {
        // Reconcile with backend truth after optimistic update.
        await invalidateMcpQueries(utils);
      }
    },
    [toggleEnabledMutation, utils],
  );

  return {
    handleAddMcp,
    handleSaveCredentials,
    handleDelete,
    handleReconnect,
    handleToggleEnabled,
    handleRefresh,
    utils,
  };
}
