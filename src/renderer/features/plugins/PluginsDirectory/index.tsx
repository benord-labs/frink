/**
 * The plugin directory: browse what Frink can connect, then open one to read
 * exactly what it installs before connecting an account. Rows group by
 * availability and live connections, never by installation — see plugin-filters.
 */
import { Alert } from '@benord-labs/frink-primitives';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SettingsFoldGroup } from '@/components/settings/SettingsList';
import {
  applyFilter,
  buildFilters,
  groupPlugins,
  type PluginFilterId,
  type PluginToolsStates,
  searchPlugins,
} from '../../../lib/plugins/plugin-filters';
import type { PluginToolsState } from '../../../lib/plugins/plugin-view-model';
import { trpc } from '../../../lib/trpc';
import { PluginGridRow } from '../PluginGridRow';
import { DIRECTORY_GRID, DirectoryFrame } from './DirectoryFrame';
import { DirectorySkeleton } from './DirectorySkeleton';
import { DirectoryToolbar } from './DirectoryToolbar';

// Ruled along the bottom edge so column two's first row is not double-ruled under the section line.
const GRID_ROWS = `${DIRECTORY_GRID} [&>li]:border-t-0 [&>li]:border-b`;

type Props = {
  /** Delivery health per plugin id, sourced from the integration rows. */
  /** Plugin whose row should take focus, set when its page closes. */
  restoreFocusTo?: string | null;
  onOpen: (pluginId: string) => void;
};

export function PluginsDirectory({ restoreFocusTo, onOpen }: Props) {
  const [filter, setFilter] = useState<PluginFilterId>('all');
  const [query, setQuery] = useState('');
  const { data, isLoading, isError } = trpc.plugins.list.useQuery();
  // The tools half of every plugin's status. A failed or unsettled read leaves each
  // plugin 'unknown', so a missing grant never retracts a live account's badge.
  const mcp = trpc.plugins.vendorMcpStatus.useQuery(undefined, { staleTime: 5_000 });
  const toolsStates = useMemo<PluginToolsStates>(() => {
    const states = new Map<string, PluginToolsState>();
    if (mcp.isError || !mcp.data) return states;
    // Connected last: a live grant outranks a second server still awaiting one.
    for (const entry of mcp.data.awaitingAuth) states.set(entry.pluginName, 'awaiting');
    for (const entry of mcp.data.connected) states.set(entry.pluginName, 'connected');
    return states;
  }, [mcp.data, mcp.isError]);
  const rootRef = useRef<HTMLDivElement>(null);

  // The detail page is not a dialog, so nothing restores focus to the row that opened it.
  useEffect(() => {
    if (!restoreFocusTo) return;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-plugin-row="${CSS.escape(restoreFocusTo)}"] button`)
      ?.focus();
  }, [restoreFocusTo]);

  const plugins = useMemo(() => data?.plugins ?? [], [data]);
  // Coming-soon and unavailable keep their sections but get no pill: filtering
  // down to things you cannot act on is a dead end.
  const filters = useMemo(
    () =>
      buildFilters(plugins, toolsStates).filter(
        (entry) => entry.id !== 'coming_soon' && entry.id !== 'unavailable',
      ),
    [plugins, toolsStates],
  );
  // buildFilters drops empty groups, so a selected pill can stop existing.
  const active = filters.some((entry) => entry.id === filter) ? filter : 'all';
  const groups = useMemo(
    () =>
      groupPlugins(applyFilter(searchPlugins(plugins, query), active, toolsStates), toolsStates),
    [plugins, query, active, toolsStates],
  );
  const frame = { rootRef };
  const renderRow = (plugin: (typeof plugins)[number]) => (
    <PluginGridRow
      key={plugin.definition.id}
      plugin={plugin}
      tools={toolsStates.get(plugin.definition.id)}
      onOpen={onOpen}
    />
  );

  if (isError) {
    return (
      <DirectoryFrame {...frame}>
        <Alert variant="error" className="mt-8">
          Plugins are unavailable right now.
        </Alert>
      </DirectoryFrame>
    );
  }

  if (isLoading) {
    return (
      <DirectoryFrame {...frame}>
        <DirectorySkeleton />
      </DirectoryFrame>
    );
  }

  return (
    <DirectoryFrame {...frame}>
      <DirectoryToolbar
        filters={filters}
        active={active}
        query={query}
        onFilterChange={setFilter}
        onQueryChange={setQuery}
      />

      {groups.length === 0 ? (
        <p className="mt-12 text-center text-muted-fg text-sm">
          {query.trim() === '' ? 'No plugins match this filter.' : `No plugins match “${query}”.`}
        </p>
      ) : (
        <div data-testid="plugins-list">
          {groups.map((group) =>
            // Coming soon rows cannot be acted on: they fold behind their count so the actionable sections lead.
            group.id === 'coming_soon' ? (
              <div key={group.id} className="mt-8">
                <SettingsFoldGroup
                  title={group.label}
                  items={group.plugins}
                  itemKey={(plugin) => plugin.definition.id}
                  renderItem={renderRow}
                  defaultOpen={false}
                  forceOpen={query.trim() !== ''}
                  uncapped
                  listClassName={GRID_ROWS}
                />
              </div>
            ) : (
              <section key={group.id} aria-label={group.label} className="mt-8">
                <div className="flex items-baseline justify-between gap-3 border-hairline border-b px-2 pb-2">
                  <h3 className="font-semibold text-base text-ink tracking-[-0.01em]">
                    {group.label}
                  </h3>
                  <span className="text-dim text-xs tabular-nums">{group.plugins.length}</span>
                </div>
                <ul className={GRID_ROWS}>{group.plugins.map(renderRow)}</ul>
              </section>
            ),
          )}
        </div>
      )}
    </DirectoryFrame>
  );
}
