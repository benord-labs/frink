/**
 * Custom-node block — user-defined nodes whose `blockType` is the manifest
 * name (e.g. `check-new-prs`). flow-step-executor.executeCustomNode reads the
 * manifest from `~/.frink/custom-nodes/`, builds the runtime command, and
 * runs it with credential env vars injected.
 *
 * Engine selects this dispatcher when the blockType isn't a first-party block.
 */

import { buildVariables } from '../block-context';
import { renderTemplate } from '../template-utils';
import { resolveStaticProjectId } from './project-id';
import { executeShellStep } from './shell-step';
import type { Dispatcher } from './types';

type CustomNodeConfig = {
  projectId?: string;
  [key: string]: unknown;
};

export const dispatchCustomNode: Dispatcher = async (ctx) => {
  const config = (ctx.node.config ?? {}) as CustomNodeConfig;
  // Render any string config values as templates so {{trigger.*}} works in arbitrary keys.
  const variables = buildVariables({
    triggerContext: ctx.triggerContext,
    previousOutput: ctx.previousOutput,
    loopContext: ctx.loopContext,
  });
  const projectId = resolveStaticProjectId(ctx.node.config, ctx.parsedGraph.settings);
  if (!projectId) {
    return {
      type: 'error',
      message: `Custom node "${ctx.node.blockType}" missing projectId (set on the node or as the flow default project in flow settings)`,
    };
  }

  const renderedConfig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (k === 'projectId') continue;
    renderedConfig[k] = typeof v === 'string' ? renderTemplate(v, variables) : v;
  }

  const startedAt = Date.now();
  const output = await executeShellStep(
    {
      flowRunId: ctx.flowRunId,
      nodeRunId: ctx.nodeRunId,
      blockType: ctx.node.blockType,
      projectId,
      config: renderedConfig,
    },
    ctx.signal,
    startedAt,
  );
  return { type: 'completed', output };
};
