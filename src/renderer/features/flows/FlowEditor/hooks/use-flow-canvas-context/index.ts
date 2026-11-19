import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { toProjectRefs } from '../../BlockConfig/node-project-resolution';
import type { FlowNodeCanvasContext } from '../../nodeSummary';

type CustomNodeListing = { name: string; description?: string | null };

/**
 * What the canvas checks steps against: the custom-node catalog, the projects on this computer
 * and the connected accounts. Data still loading (or failed) is `null`, which skips that check.
 */
export function useFlowCanvasContext(
  customNodes: readonly CustomNodeListing[] | undefined,
  customNodesLoading: boolean,
): FlowNodeCanvasContext {
  const { data: projects } = trpc.projects.list.useQuery();
  const { data: integrations } = trpc.integrations.list.useQuery(undefined);
  return useMemo((): FlowNodeCanvasContext => {
    const resolution = {
      projects: toProjectRefs(projects),
      connectedIntegrationIds: integrations ? new Set(integrations.map((i) => i.id)) : null,
    };
    if (customNodesLoading || customNodes === undefined) {
      return { ...resolution, customDescriptionByBlockType: new Map(), customCatalogNames: null };
    }
    const desc = new Map<string, string>();
    for (const n of customNodes) {
      const text = n.description?.trim();
      if (text) desc.set(n.name, text);
    }
    return {
      ...resolution,
      customDescriptionByBlockType: desc,
      customCatalogNames: new Set(customNodes.map((n) => n.name)),
    };
  }, [customNodes, customNodesLoading, projects, integrations]);
}
