/**
 * Right panel: block-type config forms + header / dismiss.
 */

import { Button } from '@benord-labs/frink-primitives';
import { X } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback } from 'react';
import type { RunCommandExpectedOutputs } from '../../../../../shared/lib/output-schemas';
import type { FlowNode } from '../../../../../shared/lib/validate-flow-graph';
import type { NodeVariables } from '../../../../../shared/lib/validate-flow-templates';
import type { FlowBlockType, FlowSettings } from '../../../../../shared/types/flow';
import { FLOW_TRIGGER_TYPES } from '../constants';
import { FlowBlockTile } from '../FlowBlockIcon';
import { flowStepIdentity } from '../nodeSummary';
import { AgentConfig } from './AgentConfig';
import { ApprovalConfig } from './ApprovalConfig';
import { ChatReplyConfig } from './ChatReplyConfig';
import { ConditionConfig } from './ConditionConfig';
import { CustomNodeConfig } from './CustomNodeConfig';
import { FanOutConfig } from './FanOutConfig';
import { HttpRequestConfig } from './HttpRequestConfig';
import { ManualTriggerConfig } from './ManualTriggerConfig';
import { PostTaskTriggerConfig } from './PostTaskTriggerConfig';
import { RunCommandConfig } from './RunCommandConfig';
import { ScheduleTriggerConfig } from './ScheduleTriggerConfig';
import { StartTaskConfig } from './StartTaskConfig';
import type { UpstreamContextProps } from './shared';
import { TriggerTypeSwitcher } from './TriggerTypeSwitcher';
import { WebhookTriggerConfig } from './WebhookTriggerConfig';

export type NodePatch = {
  label?: string;
  config?: Record<string, unknown>;
  /** Built-in {@link FlowBlockType} id or custom node name (matches {@link FlowNode.blockType}). */
  blockType?: string;
};

type BlockConfigPanelProps = {
  flowId: string;
  flowProjectId: string | null;
  flowSettings: FlowSettings | undefined;
  selectedNode: FlowNode | null;
  /** Manifest icon key when the selected step is a custom node. */
  customBlockIcon?: string;
  /** True when the selected condition node has a back-edge (loop). */
  isLoopCondition?: boolean;
  /** Block type of the flow's trigger node (used to conditionally show execution context options). */
  triggerBlockType?: FlowBlockType;
  /** Set when trigger is `webhook_trigger` — Agent block uses this to sort recommended prompt templates. */
  webhookTriggerIntegrationId?: string;
  /** Block type of the immediate predecessor node (single-hop). Used by AvailableVariables. */
  predecessorBlockType?: string | null;
  /** Block type two hops upstream. Used by AvailableVariables when predecessor is fan_out. */
  predecessorOfPredecessorBlockType?: string | null;
  /** Declared outputs from the immediate predecessor run_command, if any. */
  predecessorExpectedOutputs?: RunCommandExpectedOutputs | null;
  /** Declared outputs from two hops upstream (for condition passthrough). */
  predecessorOfPredecessorExpectedOutputs?: RunCommandExpectedOutputs | null;
  /**
   * Nearest ancestor fan_out node — present when the selected node is inside a fan_out body chain.
   * Used to render the `{{loop.*}}` section in AvailableVariables.
   */
  ancestorFanOut?: { fanOutNodeId: string; fanOutSourceBlockType: string | null } | null;
  /** Canonical template variables for the selected node (from `computeNodeVariables`). */
  nodeVariables?: NodeVariables | null;
  customNodesLoading?: boolean;
  predecessorIsCustomNode?: boolean;
  onClose: () => void;
  onPatchNode: (nodeId: string, patch: NodePatch) => void;
  /** Opens flow settings focused on the Project field (project-field CTA when nothing is inherited). */
  onOpenFlowSettings?: () => void;
};

type ConfigBodyArgs = UpstreamContextProps & {
  flowId: string;
  flowProjectId: string | null;
  flowSettings: FlowSettings | undefined;
  node: FlowNode;
  isLoopCondition: boolean;
  webhookTriggerIntegrationId?: string;
  customNodesLoading?: boolean;
  predecessorIsCustomNode?: boolean;
  patchLabel: (patch: { label?: string }) => void;
  patchConfig: (config: Record<string, unknown>) => void;
  onOpenFlowSettings?: () => void;
};

function renderBlockConfigBody(block: FlowBlockType, args: ConfigBodyArgs): ReactElement {
  const {
    flowId,
    flowProjectId,
    flowSettings,
    node,
    isLoopCondition,
    triggerBlockType,
    webhookTriggerIntegrationId,
    predecessorBlockType,
    predecessorOfPredecessorBlockType,
    predecessorExpectedOutputs,
    predecessorOfPredecessorExpectedOutputs,
    ancestorFanOut,
    nodeVariables,
    customNodesLoading,
    predecessorIsCustomNode,
    patchLabel,
    patchConfig,
    onOpenFlowSettings,
  } = args;
  switch (block) {
    case 'manual_trigger':
      return <ManualTriggerConfig node={node} onPatch={patchLabel} />;
    case 'webhook_trigger':
      // Webhook events are authenticated + normalized on the cloud, relayed to
      // this machine, and matched against local flow graphs (webhook-match-on-
      // machine). The trigger fires locally — no inert banner needed.
      return (
        <WebhookTriggerConfig node={node} onPatchLabel={patchLabel} onPatchConfig={patchConfig} />
      );
    case 'post_task_trigger':
      return (
        <PostTaskTriggerConfig
          flowId={flowId}
          flowProjectId={flowProjectId}
          node={node}
          onPatchLabel={patchLabel}
          onPatchConfig={patchConfig}
        />
      );
    case 'schedule_trigger':
      return (
        <ScheduleTriggerConfig node={node} onPatchLabel={patchLabel} onPatchConfig={patchConfig} />
      );
    case 'start_task':
      return (
        <StartTaskConfig
          node={node}
          flowSettings={flowSettings}
          triggerBlockType={triggerBlockType}
          predecessorBlockType={predecessorBlockType}
          predecessorOfPredecessorBlockType={predecessorOfPredecessorBlockType}
          predecessorExpectedOutputs={predecessorExpectedOutputs}
          predecessorOfPredecessorExpectedOutputs={predecessorOfPredecessorExpectedOutputs}
          ancestorFanOut={ancestorFanOut}
          nodeVariables={nodeVariables}
          onPatchLabel={patchLabel}
          onConfigPatch={patchConfig}
          onOpenFlowSettings={onOpenFlowSettings}
        />
      );
    case 'agent':
      return (
        <AgentConfig
          node={node}
          flowSettings={flowSettings}
          triggerBlockType={triggerBlockType}
          webhookTriggerIntegrationId={webhookTriggerIntegrationId}
          predecessorBlockType={predecessorBlockType}
          predecessorOfPredecessorBlockType={predecessorOfPredecessorBlockType}
          predecessorExpectedOutputs={predecessorExpectedOutputs}
          predecessorOfPredecessorExpectedOutputs={predecessorOfPredecessorExpectedOutputs}
          ancestorFanOut={ancestorFanOut}
          nodeVariables={nodeVariables}
          customNodesLoading={customNodesLoading}
          predecessorIsCustomNode={predecessorIsCustomNode}
          onConfigPatch={patchConfig}
        />
      );
    case 'run_command':
      return (
        <RunCommandConfig
          node={node}
          flowSettings={flowSettings}
          triggerBlockType={triggerBlockType}
          predecessorBlockType={predecessorBlockType}
          predecessorOfPredecessorBlockType={predecessorOfPredecessorBlockType}
          predecessorExpectedOutputs={predecessorExpectedOutputs}
          predecessorOfPredecessorExpectedOutputs={predecessorOfPredecessorExpectedOutputs}
          ancestorFanOut={ancestorFanOut}
          nodeVariables={nodeVariables}
          onPatchLabel={patchLabel}
          onConfigPatch={patchConfig}
          onOpenFlowSettings={onOpenFlowSettings}
        />
      );
    case 'chat_reply':
      return (
        <ChatReplyConfig
          node={node}
          predecessorBlockType={predecessorBlockType}
          predecessorOfPredecessorBlockType={predecessorOfPredecessorBlockType}
          predecessorExpectedOutputs={predecessorExpectedOutputs}
          predecessorOfPredecessorExpectedOutputs={predecessorOfPredecessorExpectedOutputs}
          ancestorFanOut={ancestorFanOut}
          triggerBlockType={triggerBlockType}
          nodeVariables={nodeVariables}
          customNodesLoading={customNodesLoading}
          predecessorIsCustomNode={predecessorIsCustomNode}
          onPatchLabel={patchLabel}
          onConfigPatch={patchConfig}
        />
      );
    case 'http_request':
      return (
        <HttpRequestConfig node={node} onPatchLabel={patchLabel} onConfigPatch={patchConfig} />
      );
    case 'condition':
      return (
        <ConditionConfig
          node={node}
          isLoopCondition={isLoopCondition}
          onPatchLabel={patchLabel}
          onConfigPatch={patchConfig}
        />
      );
    case 'fan_out':
      return <FanOutConfig node={node} onPatchLabel={patchLabel} onConfigPatch={patchConfig} />;
    case 'approval':
      return <ApprovalConfig node={node} onPatchLabel={patchLabel} onConfigPatch={patchConfig} />;
    case 'end':
      return (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          This block terminates the flow branch. No configuration needed.
        </p>
      );
    default:
      return (
        <CustomNodeConfig
          node={args.node}
          flowSettings={flowSettings}
          triggerBlockType={triggerBlockType}
          predecessorBlockType={predecessorBlockType}
          predecessorOfPredecessorBlockType={predecessorOfPredecessorBlockType}
          predecessorExpectedOutputs={predecessorExpectedOutputs}
          predecessorOfPredecessorExpectedOutputs={predecessorOfPredecessorExpectedOutputs}
          ancestorFanOut={ancestorFanOut}
          nodeVariables={nodeVariables}
          onPatchLabel={patchLabel}
          onConfigPatch={patchConfig}
          onOpenFlowSettings={onOpenFlowSettings}
        />
      );
  }
}

export function BlockConfigPanel({
  flowId,
  flowProjectId,
  flowSettings,
  selectedNode,
  customBlockIcon,
  isLoopCondition,
  triggerBlockType,
  webhookTriggerIntegrationId,
  predecessorBlockType,
  predecessorOfPredecessorBlockType,
  predecessorExpectedOutputs,
  predecessorOfPredecessorExpectedOutputs,
  ancestorFanOut,
  nodeVariables,
  customNodesLoading,
  predecessorIsCustomNode,
  onClose,
  onPatchNode,
  onOpenFlowSettings,
}: BlockConfigPanelProps): ReactNode {
  const selectedNodeId = selectedNode?.id ?? null;

  const patchLabel = useCallback(
    (patch: { label?: string }): void => {
      if (selectedNodeId === null) return;
      onPatchNode(selectedNodeId, patch);
    },
    [onPatchNode, selectedNodeId],
  );

  const patchConfig = useCallback(
    (config: Record<string, unknown>): void => {
      if (selectedNodeId === null) return;
      onPatchNode(selectedNodeId, { config });
    },
    [onPatchNode, selectedNodeId],
  );

  if (!selectedNode) return null;

  const block = selectedNode.blockType as FlowBlockType;
  const { name, kind } = flowStepIdentity(selectedNode);
  const isTrigger = FLOW_TRIGGER_TYPES.has(block);

  const body = renderBlockConfigBody(block, {
    flowId,
    flowProjectId,
    flowSettings,
    node: selectedNode,
    isLoopCondition: isLoopCondition ?? false,
    triggerBlockType,
    webhookTriggerIntegrationId,
    predecessorBlockType,
    predecessorOfPredecessorBlockType,
    predecessorExpectedOutputs,
    predecessorOfPredecessorExpectedOutputs,
    ancestorFanOut,
    nodeVariables,
    customNodesLoading,
    predecessorIsCustomNode,
    patchLabel,
    patchConfig,
    onOpenFlowSettings,
  });

  return (
    <aside className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-transparent">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/40 px-4 py-3">
        <FlowBlockTile type={selectedNode.blockType} customBlockIcon={customBlockIcon} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-foreground" id="flow-block-config-title">
            {name}
          </h2>
          {kind !== name ? <p className="truncate text-sm text-muted-foreground">{kind}</p> : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Close configuration panel"
          onClick={onClose}
          iconOnly
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div
        className="min-h-0 min-w-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-4 py-4 scrollbar-thin"
        role="region"
        aria-labelledby="flow-block-config-title"
      >
        {isTrigger ? (
          <div className="mb-4">
            <TriggerTypeSwitcher node={selectedNode} onPatchNode={onPatchNode} />
          </div>
        ) : null}
        {body}
      </div>
    </aside>
  );
}
