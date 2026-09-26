/**
 * The generic call-tool node's config: a picker over the plugin server's live tools/list and the
 * picked tool's arguments. Probes on open (n8n's fetch-on-open shape); React Query only dedupes.
 */
import type { ReactElement } from 'react';
import { z } from 'zod';
import { trpc } from '../../../../../../lib/trpc';
import { cfg, type ProjectNodeConfigProps } from '../../shared';
import { CallToolArguments } from '../CallToolArguments';
import { ToolPickerField } from '../ToolPickerField';

type Props = {
  node: ProjectNodeConfigProps['node'];
  pluginId: string;
  onConfigPatch: ProjectNodeConfigProps['onConfigPatch'];
};

export function CallToolStep({ node, pluginId, onConfigPatch }: Props): ReactElement {
  const config = cfg(node);
  const nodeId = node.id;
  const blockType = node.blockType;
  const toolsQuery = trpc.customNodes.pluginServerTools.useQuery(
    { pluginId },
    { staleTime: 30_000, retry: false },
  );
  // A thrown procedure is a failure to show, never an endless "loading".
  const pluginTools = toolsQuery.error
    ? { ok: false as const, reason: toolsQuery.error.message }
    : toolsQuery.data;
  const pickedTool = z.string().catch('').parse(config.tool);
  return (
    <div className="flex flex-col gap-3">
      <ToolPickerField
        fieldId={`custom-node-${nodeId}-tool`}
        value={pickedTool}
        tools={pluginTools}
        onChange={(tool) => onConfigPatch({ tool, arguments: undefined })}
      />
      <CallToolArguments
        key={`${nodeId}:${pickedTool}`}
        nodeId={nodeId}
        blockType={blockType}
        tool={pluginTools?.ok ? pluginTools.tools.find((t) => t.name === pickedTool) : undefined}
        value={config.arguments}
        onConfigPatch={onConfigPatch}
      />
    </div>
  );
}
