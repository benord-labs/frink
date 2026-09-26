import { memo, useMemo, useState } from 'react';
import { SettingsFoldGroup, SettingsNoMatches } from '@/components/settings/SettingsList';
import { McpServerRow } from '../McpServerRow';
import { type McpServer, pluginMcpOwner } from '../constants';

type Props = {
  mcps: McpServer[];
  query: string;
  expandedServer: string | null;
  reconnectingServer: string | null;
  onToggleExpanded: (key: string) => void;
  onConfigure: (
    name: string,
    config: { authType?: string; url?: string; requiredEnvVars?: string[] },
  ) => void;
  onReconnect: (name: string) => void;
  onToggleEnabled: (name: string, enabled: boolean) => void;
  onDelete: (name: string) => void;
  /** Where a plugin-owned row sends the user to manage it. */
  onOpenPluginPage: () => void;
};

type Row = { mcp: McpServer; owner: ReturnType<typeof pluginMcpOwner> };

// Not 'disconnected': main also reports that for a healthy server with no tools, or a slow probe.
const ATTENTION_STATUSES = new Set(['needs_auth', 'error']);

function needsAttention({ mcp }: Row): boolean {
  return mcp.config.enabled !== false && ATTENTION_STATUSES.has(mcp.status);
}

function matches({ mcp, owner }: Row, q: string): boolean {
  return [owner?.title, mcp.name, mcp.config.description].some((text) =>
    text?.toLowerCase().includes(q),
  );
}

/**
 * Broken servers first, whoever owns them; then the user's working servers. Turned-off servers
 * and the plugins' own (managed on the Directory tab) fold away. Each sorts by the name the user reads.
 */
function groupServers(mcps: McpServer[], query: string) {
  const q = query.trim().toLowerCase();
  const rows = mcps
    .map((mcp) => ({ mcp, owner: pluginMcpOwner(mcp.name, mcp.config) }))
    .filter((row) => !q || matches(row, q))
    .sort((a, b) => (a.owner?.title ?? a.mcp.name).localeCompare(b.owner?.title ?? b.mcp.name));
  const rest = rows.filter((row) => !needsAttention(row));
  return [
    { title: 'Needs attention', rows: rows.filter(needsAttention), open: true, uncapped: true },
    {
      title: 'Your servers',
      rows: rest.filter((row) => !row.owner && row.mcp.config.enabled !== false),
      open: true,
    },
    {
      title: 'Turned off',
      rows: rest.filter((row) => !row.owner && row.mcp.config.enabled === false),
      open: false,
    },
    { title: 'From plugins', rows: rest.filter((row) => row.owner), open: false, plugins: true },
  ].filter((group) => group.rows.length > 0);
}

export const McpSection = memo(function McpSection({
  mcps,
  query,
  expandedServer,
  reconnectingServer,
  onToggleExpanded,
  onConfigure,
  onReconnect,
  onToggleEnabled,
  onDelete,
  onOpenPluginPage,
}: Props) {
  const groups = useMemo(() => groupServers(mcps, query), [mcps, query]);
  // The server last acted on, from its open row or its ⋯ menu: turning it off or fixing it moves
  // it to another group, which then opens to show it.
  const [actedOn, setActedOn] = useState<string | null>(null);

  if (groups.length === 0 && query.trim())
    return <SettingsNoMatches noun="servers" query={query} />;

  const renderRow = ({ mcp, owner }: Row) => (
    <McpServerRow
      name={owner?.title ?? mcp.name}
      description={mcp.config.description}
      url={mcp.config.url}
      status={mcp.status}
      tools={mcp.tools}
      statusDetail={mcp.error}
      needsSetup={mcp.status === 'needs_auth'}
      isExpanded={expandedServer === mcp.name}
      onToggle={() => onToggleExpanded(mcp.name)}
      isReconnecting={reconnectingServer === mcp.name}
      isEnabled={mcp.config.enabled !== false}
      onConfigure={() => {
        setActedOn(mcp.name);
        onConfigure(mcp.name, {
          authType: mcp.config.authType,
          url: mcp.config.url,
          requiredEnvVars: mcp.config.requiredEnvVars,
        });
      }}
      onReconnect={() => {
        setActedOn(mcp.name);
        onReconnect(mcp.name);
      }}
      onToggleEnabled={() => {
        setActedOn(mcp.name);
        onToggleEnabled(mcp.name, mcp.config.enabled !== false);
      }}
      onDelete={() => onDelete(mcp.name)}
      plugin={owner ?? undefined}
      onOpenPluginPage={owner ? onOpenPluginPage : undefined}
    />
  );

  return groups.map((group) => (
    <SettingsFoldGroup
      key={group.title}
      title={group.title}
      items={group.rows}
      itemKey={(row) => row.mcp.name}
      renderItem={renderRow}
      defaultOpen={group.open}
      forceOpen={query.trim() !== ''}
      uncapped={group.uncapped}
      revealKey={actedOn}
      action={
        group.plugins ? (
          <button
            type="button"
            onClick={onOpenPluginPage}
            className="cursor-pointer rounded-md px-1 py-0.5 font-normal text-xs text-muted-fg transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            Manage in Directory
          </button>
        ) : undefined
      }
    />
  ));
});
