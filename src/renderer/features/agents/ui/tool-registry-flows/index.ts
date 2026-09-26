import { Eye, List, ListTodo, MessageSquare, Play, Plus, Workflow } from 'lucide-react';
import { TERMINAL_TOOL_PART_STATES } from '../../../../../shared/types/assistant-message';
import type { MessagePart } from '../../stores/message-store';
import {
  formatFlowIdForSubtitle,
  getNumberValue,
  getStringValue,
  type ToolMeta,
} from '../tool-registry-shared';

/**
 * Tool cards for the Frink Flows MCP surface (flow CRUD, runs, batches, stage definition).
 *
 * Split out of agent-tool-registry.tsx, which had grown past its size ratchet: these entries are
 * one cohesive product surface and nothing else in the registry references them.
 *
 * Every card shares two shapes — a title that flips pending → done, and a subtitle showing one
 * truncated id — so those are parameterised helpers rather than repeated per entry. Only the cards
 * whose wording genuinely differs (an op count, a stage number, a broadcast target) spell it out.
 */
const isPending = (part: MessagePart): boolean => !TERMINAL_TOOL_PART_STATES.has(part.state ?? '');

/** Title that reads as an action in progress until the tool reports a result. */
const phase =
  (pending: string, done: string) =>
  (part: MessagePart): string =>
    isPending(part) ? pending : done;

/** One truncated id, held back until the tool input has finished streaming in. */
const idOf =
  (key: string) =>
  (part: MessagePart): string =>
    part.state === 'input-streaming'
      ? ''
      : formatFlowIdForSubtitle(getStringValue(part.input, key));

export const FLOWS_TOOL_ENTRIES: Record<string, ToolMeta> = {
  'tool-frink_flows_patch': {
    icon: Workflow,
    title: phase('Patching Flow...', 'Patched Flow'),
    subtitle: (part) => {
      const flowId = getStringValue(part.input, 'flowId');
      const ops = part.input?.operations;
      const n = Array.isArray(ops) ? ops.length : 0;
      const suffix = n > 0 ? ` · ${n} op${n === 1 ? '' : 's'}` : '';
      if (flowId.length === 0) return suffix.trim();
      return `${formatFlowIdForSubtitle(flowId)}${suffix}`;
    },
    variant: 'simple',
  },

  'tool-frink_flows_list': {
    icon: List,
    title: phase('Listing Flows...', 'Listed Flows'),
    variant: 'simple',
  },

  'tool-frink_flows_list_catalog': {
    icon: List,
    title: phase('Listing Catalog...', 'Listed Catalog'),
    // The catalog kind is a plain word, not an id — shown as-is rather than truncated.
    subtitle: (part) =>
      part.state === 'input-streaming' ? '' : getStringValue(part.input, 'kind'),
    variant: 'simple',
  },

  'tool-frink_flows_get': {
    icon: Workflow,
    title: phase('Getting Flow...', 'Got Flow'),
    subtitle: (part) => formatFlowIdForSubtitle(getStringValue(part.input, 'flowId')),
    variant: 'simple',
  },

  'tool-frink_flows_add_stage_runs': {
    icon: ListTodo,
    title: phase('Adding stage runs...', 'Added stage runs'),
    subtitle: (part) => {
      if (part.state === 'input-streaming') return '';
      const batchId = getStringValue(part.input, 'batchId');
      const stage = getNumberValue(part.input, 'stageNumber');
      const batch = formatFlowIdForSubtitle(batchId);
      return stage > 0 ? `${batch} · stage ${stage}` : batch;
    },
    variant: 'simple',
  },

  'tool-frink_flows_run': {
    icon: Play,
    title: phase('Starting flow run...', 'Started flow run'),
    subtitle: (part) => formatFlowIdForSubtitle(getStringValue(part.input, 'flowId')),
    variant: 'simple',
  },

  'tool-frink_flows_get_run': {
    icon: Eye,
    title: phase('Inspecting Run...', 'Inspected Run'),
    subtitle: idOf('runId'),
    variant: 'simple',
  },

  'tool-frink_flows_get_batch': {
    icon: Eye,
    // Without a batchId this call lists every run, so the card says so instead of naming a batch.
    title: (part) => {
      const batchId = getStringValue(part.input, 'batchId');
      if (!batchId) return isPending(part) ? 'Listing Runs...' : 'Listed Runs';
      return isPending(part) ? 'Inspecting Batch...' : 'Inspected Batch';
    },
    subtitle: (part) => {
      if (part.state === 'input-streaming') return '';
      const batchId = getStringValue(part.input, 'batchId');
      const flowId = getStringValue(part.input, 'flowId');
      return formatFlowIdForSubtitle(batchId || flowId);
    },
    variant: 'simple',
  },

  'tool-frink_register_node': {
    icon: Plus,
    title: phase('Registering Node...', 'Registered Node'),
    variant: 'simple',
  },

  'tool-frink_batch_message': {
    icon: MessageSquare,
    title: phase('Sending Batch Message...', 'Sent Batch Message'),
    subtitle: (part) => {
      if (part.state === 'input-streaming') return '';
      const batchId = getStringValue(part.input, 'batchId');
      const flowRunId = getStringValue(part.input, 'flowRunId');
      const target = flowRunId ? `→ ${formatFlowIdForSubtitle(flowRunId)}` : 'broadcast';
      return `${formatFlowIdForSubtitle(batchId)} ${target}`;
    },
    variant: 'simple',
  },

  'tool-frink_flows_define_stages': {
    icon: ListTodo,
    title: phase('Defining Stages...', 'Defined Stages'),
    subtitle: idOf('batchId'),
    variant: 'simple',
  },

  'tool-frink_flows_start_batch': {
    icon: Play,
    title: phase('Starting batch...', 'Started batch'),
    subtitle: idOf('batchId'),
    variant: 'simple',
  },
};
