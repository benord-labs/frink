import { useSetAtom } from 'jotai';
import { Server } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  SettingsEmptyState,
  SettingsSearch,
  WARNING_TEXT_CLASS,
} from '@/components/settings/SettingsList';
import { LoadingState } from '@/components/ui/loading-state';
import { codeEditorMaximizedAtom, openFileAtom } from '@/features/code-editor';
import { useMcpHandlers } from '@/hooks/use-mcp-handlers';
import { agentsSettingsDialogActiveTabAtom } from '@/lib/atoms';
import { trpc } from '@/lib/trpc';
import { SubviewActions } from '../SettingsSubviewPage';
import { AddMcpDialog } from './AddMcpDialog';
import { ConfigureMcpDialog } from './ConfigureMcpDialog';
import type { McpServer } from './constants';
import { Header } from './Header';
import { McpSection } from './McpSection';

export function AgentsMcpTab() {
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [reconnectingServer, setReconnectingServer] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [configureDialog, setConfigureDialog] = useState<{
    open: boolean;
    serverName: string;
    authType?: string;
    url?: string;
    requiredEnvVars?: string[];
    existingEnv?: Record<string, string>;
    existingHeaders?: Record<string, string>;
  }>({ open: false, serverName: '' });

  const {
    data: frinkMcps,
    isLoading: isLoadingFrink,
    isError: isFrinkError,
  } = trpc.mcp.getAggregatedMcpInfo.useQuery(undefined, {
    staleTime: 60_000,
    placeholderData: (previousData) => previousData,
  });
  const { data: localFrinkServers } = trpc.mcp.listGlobalServers.useQuery(undefined, {
    staleTime: 5_000,
    placeholderData: (previousData) => previousData,
  });

  const { data: homePath } = trpc.external.getHomePath.useQuery();
  const openFile = useSetAtom(openFileAtom);
  const setMaximized = useSetAtom(codeEditorMaximizedAtom);

  const {
    handleAddMcp,
    handleSaveCredentials,
    handleDelete,
    handleReconnect,
    handleToggleEnabled,
    handleRefresh: handleRefreshCore,
    utils,
  } = useMcpHandlers(setReconnectingServer, configureDialog.serverName);

  const displayFrinkMcps = useMemo<McpServer[]>(() => {
    if (frinkMcps !== undefined) return frinkMcps;
    if (!localFrinkServers) return frinkMcps ?? [];

    return Object.entries(localFrinkServers).map(([name, config]) => ({
      name,
      config,
      status: 'starting',
      tools: [] as string[],
      error: undefined,
    }));
  }, [frinkMcps, localFrinkServers]);

  const totalMcps = displayFrinkMcps?.length || 0;
  const isInitialFrinkLoad = isLoadingFrink && !frinkMcps && !localFrinkServers;
  const hasFrinkFallbackData = Boolean(frinkMcps) || Boolean(localFrinkServers);
  const shouldShowStaleBanner = isFrinkError && !isInitialFrinkLoad;
  const hasStaleFallbackWhileError = isFrinkError && hasFrinkFallbackData;
  const shouldShowEmptyState = totalMcps === 0 && !hasStaleFallbackWhileError;

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await handleRefreshCore();
    setIsRefreshing(false);
  }, [handleRefreshCore]);

  const handleConfigure = useCallback(
    (
      serverName: string,
      config: { authType?: string; url?: string; requiredEnvVars?: string[] },
    ) => {
      setConfigureDialog({
        open: true,
        serverName,
        authType: config.authType,
        url: config.url,
        requiredEnvVars: config.requiredEnvVars,
        existingEnv: undefined,
        existingHeaders: undefined,
      });

      utils.mcp.getCredentials
        .fetch({ serverName })
        .then((creds) => {
          setConfigureDialog((prev) => ({
            ...prev,
            existingEnv: creds?.env,
            existingHeaders: creds?.headers,
          }));
        })
        .catch(() => {
          // No existing credentials
        });
    },
    [utils],
  );

  const startMcpOAuthMutation = trpc.claude.startMcpOAuth.useMutation();

  const applyMcpAuthSuccess = useCallback(
    (serverName: string) => {
      // Optimistically mark the MCP as connected so the UI updates instantly.
      // getAggregatedMcpInfo sequentially probes tools on every MCP (up to
      // 20s each via StreamableHTTP connect + listTools), so awaiting a full
      // invalidation would leave the row stale for 30–60s.
      utils.mcp.getAggregatedMcpInfo.setData(undefined, (current) => {
        if (!current) return current;
        return current.map((m) =>
          m.name === serverName
            ? { ...m, status: 'connected', hasCredentials: true, error: undefined }
            : m,
        );
      });
      void utils.mcp.getAggregatedMcpInfo.invalidate();
    },
    [utils],
  );

  // Stable ref keeps the IPC subscription closure pointing at the latest
  // applyMcpAuthSuccess without re-registering the listener on every render.
  const applyMcpAuthSuccessRef = useRef(applyMcpAuthSuccess);
  useEffect(() => {
    applyMcpAuthSuccessRef.current = applyMcpAuthSuccess;
  });

  const handleStartOAuth = useCallback(async () => {
    const { serverName } = configureDialog;
    if (!serverName) return;

    if (!displayFrinkMcps?.some((m) => m.name === serverName)) {
      toast.error('Could not find this MCP server in the current list.');
      return;
    }

    try {
      // `__global__` is main's GLOBAL_MCP_PATH sentinel.
      const result = await startMcpOAuthMutation.mutateAsync({
        serverName,
        projectPath: '__global__',
      });
      if (result.success) {
        toast.success(`Authenticated with ${serverName}`);
        setConfigureDialog((prev) => ({ ...prev, open: false }));
        applyMcpAuthSuccess(serverName);
      } else {
        toast.error(result.error || 'Authentication failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Authentication failed');
    }
  }, [applyMcpAuthSuccess, configureDialog, displayFrinkMcps, startMcpOAuthMutation.mutateAsync]);

  // Subscribe to the main-process OAuth completion event for the lifetime of
  // this tab. Handles the case where auth completes after the dialog is closed
  // or reopened (e.g. user switches away and back mid-flow).
  useEffect(() => {
    if (!window.desktopApi?.onMcpAuthCompleted) return;
    return window.desktopApi.onMcpAuthCompleted(({ serverName, success }) => {
      if (!success) return;
      applyMcpAuthSuccessRef.current(serverName);
    });
  }, []);

  const handleToggleExpanded = useCallback((key: string) => {
    setExpandedServer((prev) => (prev === key ? null : key));
  }, []);

  // The Plugins page owns plugin sign-in, so a plugin row hands the user over
  // rather than running a second copy of that flow from here.
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const handleOpenPluginPage = useCallback(() => {
    setSettingsActiveTab('integrations');
  }, [setSettingsActiveTab]);

  const handleEditRawConfig = useCallback(() => {
    if (!homePath) {
      toast.error('Could not resolve home directory path');
      return;
    }
    const mcpDir = `${homePath}/.frink/mcp`;
    const configPath = `${mcpDir}/config.json`;
    openFile({
      path: configPath,
      name: 'config.json',
      language: 'json',
      intent: 'pinned',
      projectPath: mcpDir,
    });
    setMaximized(true);
  }, [homePath, openFile, setMaximized]);

  return (
    <div className="space-y-8">
      <SubviewActions>
        <Header
          isRefreshing={isRefreshing}
          onRefresh={handleRefresh}
          onEditRawConfig={handleEditRawConfig}
          onAddClick={() => setAddDialogOpen(true)}
        />
      </SubviewActions>

      <div className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-3">
        <p className="px-2 text-sm text-muted-fg">
          Servers give your agents extra tools. Plugins add their own.
        </p>
        {shouldShowEmptyState ? null : (
          <SettingsSearch noun="servers" value={query} onChange={setQuery} />
        )}
      </div>

      {isInitialFrinkLoad ? (
        <LoadingState message="Loading servers..." className="py-16" />
      ) : shouldShowEmptyState ? (
        <SettingsEmptyState
          icon={Server}
          title="No servers yet"
          body="Servers you add yourself show up here."
        />
      ) : (
        <div className="space-y-8">
          {shouldShowStaleBanner ? (
            <p className={`px-2 text-xs ${WARNING_TEXT_CLASS}`}>
              {hasFrinkFallbackData
                ? 'Showing the last known servers. Checking them again failed.'
                : 'Could not check your servers.'}
            </p>
          ) : null}

          <McpSection
            mcps={displayFrinkMcps}
            query={query}
            expandedServer={expandedServer}
            reconnectingServer={reconnectingServer}
            onToggleExpanded={handleToggleExpanded}
            onConfigure={handleConfigure}
            onReconnect={handleReconnect}
            onToggleEnabled={handleToggleEnabled}
            onDelete={handleDelete}
            onOpenPluginPage={handleOpenPluginPage}
          />
        </div>
      )}

      <AddMcpDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} onAdd={handleAddMcp} />

      <ConfigureMcpDialog
        open={configureDialog.open}
        onOpenChange={(open) => setConfigureDialog((prev) => ({ ...prev, open }))}
        serverName={configureDialog.serverName}
        authType={configureDialog.authType}
        url={configureDialog.url}
        requiredEnvVars={configureDialog.requiredEnvVars}
        existingEnv={configureDialog.existingEnv}
        existingHeaders={configureDialog.existingHeaders}
        onSave={handleSaveCredentials}
        onStartOAuth={handleStartOAuth}
        isOAuthInProgress={startMcpOAuthMutation.isPending}
      />
    </div>
  );
}
