/**
 * Search and grouping for the plugin directory.
 *
 * Grouping deliberately keys off availability and live connections rather than
 * installation. Nothing writes plugin_installations yet, so every plugin
 * resolves to `not_installed` — grouping by install state would file a working
 * Shortcut account under "Not installed" and contradict its own detail pane.
 */
import type { ResolvedPlugin } from '../../../shared/integrations/plugins';
import { type PluginToolsState, resolvePluginStatus } from './plugin-view-model';

/** The tools grant per plugin id as the status poll reports it. A missing id reads as `unknown`,
 * which says the same as `none`: neither retracts anything `resolvePluginStatus` would say. */
export type PluginToolsStates = ReadonlyMap<string, PluginToolsState>;

/**
 * `coming_soon` and `unavailable` stay separate: the first is a provider Frink
 * has not shipped, the second one a launch flag turned off. Folding them would
 * put a plugin under a "Coming soon" heading while its own badge said
 * "Unavailable".
 */
export type PluginGroupId = 'connected' | 'available' | 'unavailable' | 'coming_soon';

export type PluginGroup = {
  id: PluginGroupId;
  label: string;
  plugins: ResolvedPlugin[];
};

export type PluginFilterId = 'all' | PluginGroupId;

export type PluginFilter = {
  id: PluginFilterId;
  label: string;
  count: number;
};

/**
 * Derived from `resolvePluginStatus` rather than re-deriving the axes, so the
 * section a plugin sits in and the badge it wears cannot disagree.
 */
export function groupIdFor(
  plugin: ResolvedPlugin,
  tools: PluginToolsState = 'unknown',
): PluginGroupId {
  const status = resolvePluginStatus(plugin, tools);
  if (status.id === 'coming_soon') return 'coming_soon';
  if (status.id === 'unavailable') return 'unavailable';
  // Turned off is still installed: it files under Connected so its accounts
  // stay reachable and the row never re-offers "Connect".
  if (status.id === 'disabled') return 'connected';
  return status.id === 'connected' ? 'connected' : 'available';
}

function matchesQuery(plugin: ResolvedPlugin, query: string): boolean {
  const haystack = [
    plugin.definition.name,
    plugin.definition.description,
    ...(plugin.definition.keywords ?? []),
    ...plugin.definition.contents.triggers.map((trigger) => trigger.label),
    ...plugin.definition.contents.mcpServers.map((server) => server.label),
    ...plugin.definition.contents.actions.map((action) => action.label),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export function searchPlugins(
  plugins: ReadonlyArray<ResolvedPlugin>,
  query: string,
): ResolvedPlugin[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return [...plugins];
  return plugins.filter((plugin) => matchesQuery(plugin, trimmed));
}

function groupLabel(id: PluginGroupId): string {
  switch (id) {
    case 'connected':
      return 'Connected';
    case 'available':
      return 'Available';
    case 'unavailable':
      return 'Unavailable';
    case 'coming_soon':
      return 'Coming soon';
  }
}

const GROUP_ORDER: PluginGroupId[] = ['connected', 'available', 'unavailable', 'coming_soon'];

const NO_TOOLS: PluginToolsStates = new Map();

function groupOf(plugin: ResolvedPlugin, tools: PluginToolsStates) {
  return groupIdFor(plugin, tools.get(plugin.definition.id));
}

/** Empty groups are dropped — a header over a hairline with nothing under it reads as a bug. */
export function groupPlugins(
  plugins: ReadonlyArray<ResolvedPlugin>,
  tools: PluginToolsStates = NO_TOOLS,
): PluginGroup[] {
  return GROUP_ORDER.map((id) => ({
    id,
    label: groupLabel(id),
    plugins: plugins.filter((plugin) => groupOf(plugin, tools) === id),
  })).filter((group) => group.plugins.length > 0);
}

/** Counts come from the unfiltered catalog so a search never makes a filter look empty. */
export function buildFilters(
  plugins: ReadonlyArray<ResolvedPlugin>,
  tools: PluginToolsStates = NO_TOOLS,
): PluginFilter[] {
  const counts = GROUP_ORDER.map((id) => ({
    id,
    label: groupLabel(id),
    count: plugins.filter((plugin) => groupOf(plugin, tools) === id).length,
  }));
  return [
    { id: 'all', label: 'All', count: plugins.length },
    ...counts.filter((filter) => filter.count > 0),
  ];
}

export function applyFilter(
  plugins: ReadonlyArray<ResolvedPlugin>,
  filter: PluginFilterId,
  tools: PluginToolsStates = NO_TOOLS,
): ResolvedPlugin[] {
  if (filter === 'all') return [...plugins];
  return plugins.filter((plugin) => groupOf(plugin, tools) === filter);
}
