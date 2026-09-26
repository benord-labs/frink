/**
 * Category builder for the node-creator palette's manifest-backed sections.
 */

import { getPluginDefinition } from '../../../../shared/integrations/plugins';

type DiscoveredNode = {
  name: string;
  displayName: string;
  description: string;
  icon?: string | null;
  pluginId?: string | null;
};

/**
 * Custom vs Integrations, integrations grouped by first-appearance plugin: the list chunks
 * CONSECUTIVE per-plugin runs, so keyboard order must equal render order.
 */
export function buildCustomNodeCategories(customNodes: readonly DiscoveredNode[] | undefined) {
  const labels = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const icons = new Map<string, string>();
  const meta = new Map<string, { pluginId: string; pluginLabel: string }>();
  const types: string[] = [];
  const integrationTypes: string[] = [];
  for (const n of customNodes ?? []) {
    (n.pluginId ? integrationTypes : types).push(n.name);
    if (n.pluginId) {
      meta.set(n.name, {
        pluginId: n.pluginId,
        pluginLabel: getPluginDefinition(n.pluginId)?.name ?? n.pluginId,
      });
    }
    labels.set(n.name, n.displayName);
    descriptions.set(n.name, n.description);
    if (typeof n.icon === 'string' && n.icon.trim() !== '') {
      icons.set(n.name, n.icon.trim());
    }
  }
  const pluginOrder = [...new Set(integrationTypes.map((t) => meta.get(t)?.pluginId ?? ''))];
  integrationTypes.sort(
    (a, b) =>
      pluginOrder.indexOf(meta.get(a)?.pluginId ?? '') -
      pluginOrder.indexOf(meta.get(b)?.pluginId ?? ''),
  );
  return {
    customCategory: types.length > 0 ? { id: 'custom', label: 'Custom', types } : null,
    integrationsCategory:
      integrationTypes.length > 0
        ? { id: 'integrations', label: 'Integrations', types: integrationTypes }
        : null,
    customLabels: labels,
    customDescriptions: descriptions,
    customBlockIcons: icons,
    pluginMeta: meta,
  };
}
