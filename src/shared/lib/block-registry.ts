/**
 * Canonical registry for Frink Flow block types (metadata + ordering).
 * Canonical source: `src/shared/lib/block-registry.ts`. The deploy copy
 */

type FlowBlockCategory = 'triggers' | 'actions' | 'logic';

export type BlockRegistration = {
  type: string;
  label: string;
  description: string;
  category: FlowBlockCategory;
  isTrigger: boolean;
};

type BlockRegistry = {
  readonly definitions: readonly BlockRegistration[];
  readonly types: readonly string[];
  readonly typeSet: ReadonlySet<string>;
  readonly triggerTypeSet: ReadonlySet<string>;
};

/**
 * Build lookup sets from block registrations (used when merging first-party + extension blocks).
 */
function createBlockRegistry(definitions: readonly BlockRegistration[]): BlockRegistry {
  const types = definitions.map((d) => d.type);
  const typeSet = new Set(types);
  const triggerTypeSet = new Set(definitions.filter((d) => d.isTrigger).map((d) => d.type));
  return {
    definitions,
    types,
    typeSet,
    triggerTypeSet,
  };
}

export const V1_FLOW_BLOCK_DEFINITIONS = [
  {
    type: 'manual_trigger',
    label: 'Manual Trigger',
    description: 'Start the flow from the app with Run',
    category: 'triggers',
    isTrigger: true,
  },
  {
    type: 'webhook_trigger',
    label: 'Webhook Trigger',
    description: 'Start when an integration event matches',
    category: 'triggers',
    isTrigger: true,
  },
  {
    type: 'post_task_trigger',
    label: 'Post-Task Trigger',
    description: 'Start when a task completes in the bound project',
    category: 'triggers',
    isTrigger: true,
  },
  {
    type: 'schedule_trigger',
    label: 'Schedule Trigger',
    description: 'Start on a cron schedule',
    category: 'triggers',
    isTrigger: true,
  },
  {
    type: 'start_task',
    label: 'Start Task',
    description: 'Provision task environment: project, model, worktree, and branch',
    category: 'actions',
    isTrigger: false,
  },
  {
    type: 'agent',
    label: 'Agent',
    description:
      'Run the AI agent with your instructions. After Start Task for new work, or after another Agent to continue on the same path',
    category: 'actions',
    isTrigger: false,
  },
  {
    type: 'run_command',
    label: 'Run Command',
    description: 'Execute a shell command on the machine (captures stdout/stderr for the flow)',
    category: 'actions',
    isTrigger: false,
  },
  {
    type: 'http_request',
    label: 'HTTP Request',
    description: 'Call an external URL and pass the response downstream',
    category: 'actions',
    isTrigger: false,
  },
  {
    type: 'condition',
    label: 'Condition',
    description: 'Branch on true / false from an expression',
    category: 'logic',
    isTrigger: false,
  },
  {
    type: 'fan_out',
    label: 'Fan Out',
    description: 'Iterate over an array, running the next block once per item',
    category: 'logic',
    isTrigger: false,
  },
  {
    type: 'approval',
    label: 'Approval',
    description: 'Pause until approved or rejected',
    category: 'logic',
    isTrigger: false,
  },
  {
    type: 'chat_reply',
    label: 'Chat Reply',
    description: 'Post a message into the originating chat session',
    category: 'actions',
    isTrigger: false,
  },
  {
    type: 'end',
    label: 'End',
    description: 'Terminate this branch of the flow without performing any action',
    category: 'logic',
    isTrigger: false,
  },
] as const satisfies readonly BlockRegistration[];

export type FlowBlockType = (typeof V1_FLOW_BLOCK_DEFINITIONS)[number]['type'];

export const FLOW_BLOCK_TYPES = V1_FLOW_BLOCK_DEFINITIONS.map(
  (d) => d.type,
) as readonly FlowBlockType[];

const V1_BLOCK_REGISTRY = createBlockRegistry(V1_FLOW_BLOCK_DEFINITIONS);

const { typeSet: BLOCK_SET, triggerTypeSet: TRIGGER_TYPES } = V1_BLOCK_REGISTRY;

const CACHED_TRIGGER_BLOCK_TYPES = Object.freeze(
  V1_FLOW_BLOCK_DEFINITIONS.filter((d) => d.isTrigger).map((d) => d.type),
) as readonly FlowBlockType[];

const CACHED_ADDABLE_BLOCK_TYPES = Object.freeze(
  V1_FLOW_BLOCK_DEFINITIONS.filter((d) => !d.isTrigger).map((d) => d.type),
) as readonly FlowBlockType[];

const { labels: CACHED_FLOW_BLOCK_DISPLAY_LABELS, descriptions: CACHED_FLOW_BLOCK_DESCRIPTIONS } =
  (() => {
    const labels = {} as Record<FlowBlockType, string>;
    const descriptions = {} as Record<FlowBlockType, string>;
    for (const d of V1_FLOW_BLOCK_DEFINITIONS) {
      labels[d.type] = d.label;
      descriptions[d.type] = d.description;
    }
    return {
      labels: Object.freeze(labels),
      descriptions: Object.freeze(descriptions),
    };
  })();

/** Lookup registration by block type string (unknown types return undefined). */
export function getBlockRegistration(blockType: string): BlockRegistration | undefined {
  return V1_FLOW_BLOCK_DEFINITIONS.find((d) => d.type === blockType);
}

export function isRegisteredBlockType(blockType: string): blockType is FlowBlockType {
  return BLOCK_SET.has(blockType);
}

/** Pattern for user-defined custom node names (e.g. "check-new-prs"). */
const CUSTOM_NODE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Returns true for strings that look like a custom node name but are not first-party block types. */
export function isCustomNodeBlockType(blockType: string): boolean {
  return CUSTOM_NODE_NAME_RE.test(blockType) && !BLOCK_SET.has(blockType);
}

export function isTriggerBlockType(blockType: string): boolean {
  return TRIGGER_TYPES.has(blockType);
}

export function getTriggerBlockTypes(): readonly FlowBlockType[] {
  return CACHED_TRIGGER_BLOCK_TYPES;
}

export function getAddableBlockTypes(): readonly FlowBlockType[] {
  return CACHED_ADDABLE_BLOCK_TYPES;
}

/** Labels keyed by block type (for validation copy + UI). */
export function getFlowBlockDisplayLabels(): Readonly<Record<FlowBlockType, string>> {
  return CACHED_FLOW_BLOCK_DISPLAY_LABELS;
}

/** Short descriptions for node creator panel. */
export function getFlowBlockDescriptions(): Readonly<Record<FlowBlockType, string>> {
  return CACHED_FLOW_BLOCK_DESCRIPTIONS;
}

export type NodeCreatorCategory = {
  id: string;
  label: string;
  types: string[];
};

/** Categories for the flow node creator (order preserved). */
export function getNodeCreatorCategories(): readonly NodeCreatorCategory[] {
  const byCategory = (cat: FlowBlockCategory): FlowBlockType[] =>
    V1_FLOW_BLOCK_DEFINITIONS.filter((d) => d.category === cat).map((d) => d.type);

  return [
    { id: 'triggers', label: 'Triggers', types: byCategory('triggers') },
    { id: 'actions', label: 'Actions', types: byCategory('actions') },
    { id: 'logic', label: 'Logic', types: byCategory('logic') },
  ] as const;
}
