/**
 * Toolbar indicator for custom node discovery health (local manifests + cloud catalog).
 */

import { Button } from '@benord-labs/frink-primitives';
import { AlertTriangle, ChevronDown, RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { findPluginActionByNodeName } from '../../../../../shared/integrations/plugin-nodes';
import { isCustomNodeBlockType } from '../../../../../shared/lib/block-registry';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../components/ui/dropdown-menu';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';

type NodeHealthBadgeProps = {
  graph: FlowGraph;
};

export function NodeHealthBadge({ graph }: NodeHealthBadgeProps): ReactElement | null {
  const utils = trpc.useUtils();
  const {
    data: discovery,
    isError: discoveryError,
    isFetching: discoveryFetching,
  } = trpc.customNodes.discoverLocal.useQuery(undefined, { staleTime: 30_000 });

  const { data: catalog } = trpc.customNodes.list.useQuery(undefined, { staleTime: 30_000 });

  const syncMutation = trpc.customNodes.sync.useMutation({
    onSuccess: () => {
      void utils.customNodes.discoverLocal.invalidate();
      void utils.customNodes.list.invalidate();
    },
    onError: (err) => {
      console.error('customNodes.sync failed', err);
      toast.error(err.message || 'Could not refresh custom nodes');
    },
  });

  const catalogNames = useMemo(() => new Set((catalog ?? []).map((n) => n.name)), [catalog]);

  const customInGraph = useMemo(
    () => graph.nodes.filter((n) => isCustomNodeBlockType(n.blockType)),
    [graph.nodes],
  );

  const issues = useMemo(() => {
    if (customInGraph.length === 0) return [];
    /** One row per blockType — multiple graph nodes can share the same custom type. */
    const linesByBlockType = new Map<string, string[]>();
    for (const n of customInGraph) {
      const name = n.blockType;
      const lines: string[] = [];
      if (catalog != null && !catalogNames.has(name)) {
        // A plugin step exists while its plugin is connected AND its fields are loaded; nothing on disk to refresh.
        const plugin = findPluginActionByNodeName(name)?.pluginId;
        lines.push(
          plugin
            ? `${plugin} step unavailable — connect ${plugin} in Settings → Plugins, or turn it off and on to reload its fields`
            : 'Manifest not discovered locally — refresh custom nodes',
        );
      }
      if (discovery) {
        const err = discovery.errors.find((e) => e.dir === name);
        if (err) lines.push(err.error);
        const mw = discovery.manifestWarnings.find((w) => w.name === name);
        if (mw) lines.push(...mw.warnings);
      }
      if (lines.length === 0) continue;
      const merged = linesByBlockType.get(name);
      if (merged) merged.push(...lines);
      else linesByBlockType.set(name, [...lines]);
    }
    const rows: Array<{ nodeName: string; lines: string[] }> = [];
    for (const [nodeName, lines] of linesByBlockType) {
      rows.push({ nodeName, lines: Array.from(new Set(lines)) });
    }
    return rows;
  }, [catalog, catalogNames, customInGraph, discovery]);

  const scanError = discoveryError;
  const hasIssues = scanError || issues.length > 0;

  if (customInGraph.length === 0 && !discoveryFetching && !scanError) {
    return null;
  }
  if (customInGraph.length > 0 && !hasIssues && !discoveryFetching) {
    return null;
  }

  const hasBodyContent = scanError || issues.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-6 gap-1 px-1.5 text-[11px]',
            hasIssues ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
          )}
          title="Custom node health"
        >
          {scanError ? (
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <span className="tabular-nums">{issues.length}</span>
          )}
          <span className="max-w-28 truncate">Nodes</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 w-80 overflow-y-auto">
        {scanError ? (
          <p className="px-2 py-1.5 text-xs text-destructive">
            Could not scan local custom nodes. Check disk access and try again.
          </p>
        ) : null}
        {issues.map(({ nodeName, lines }) => (
          <div key={nodeName} className="border-b border-border/40 px-2 py-2 last:border-0">
            <p className="text-xs font-medium text-foreground">{nodeName}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
              {lines.map((line) => (
                <li key={`${nodeName}::${line}`}>{line}</li>
              ))}
            </ul>
          </div>
        ))}
        {hasBodyContent ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          className="gap-2 text-xs"
          disabled={syncMutation.isPending}
          onSelect={(e) => {
            e.preventDefault();
            syncMutation.mutate();
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Sync custom nodes to cloud
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
