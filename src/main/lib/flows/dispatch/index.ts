/**
 * Dispatch table — selects the per-block-type handler for one node run.
 *
 * Custom nodes (user manifest blocks whose name matches `[a-z0-9][a-z0-9_-]*`)
 * fall through to dispatchCustomNode. All first-party block types are now wired.
 */

import { findPluginActionByNodeName } from '../../../../shared/integrations/plugin-nodes';
import { isCustomNodeBlockType } from '../../../../shared/lib/block-registry';
import { dispatchAgent } from './agent';
import { dispatchApproval } from './approval';
import { dispatchChatReply } from './chat-reply';
import { dispatchCondition } from './condition';
import { dispatchCustomNode } from './custom-node';
import { dispatchPluginNode } from './plugin-node';
import { dispatchEnd } from './end';
import { dispatchFanOut } from './fan-out';
import { dispatchHttpRequest } from './http-request';
import { dispatchRunCommand } from './run-command';
import { dispatchStartTask } from './start-task';
import { dispatchTrigger } from './trigger';
import type { Dispatcher } from './types';

const TRIGGER_BLOCKS = new Set([
  'manual_trigger',
  'webhook_trigger',
  'post_task_trigger',
  'schedule_trigger',
]);

const FIRST_PARTY_DISPATCH: Record<string, Dispatcher> = {
  start_task: dispatchStartTask,
  run_command: dispatchRunCommand,
  http_request: dispatchHttpRequest,
  condition: dispatchCondition,
  approval: dispatchApproval,
  fan_out: dispatchFanOut,
  agent: dispatchAgent,
  chat_reply: dispatchChatReply,
  end: dispatchEnd,
};

export const dispatchNode: Dispatcher = async (ctx) => {
  const blockType = ctx.node.blockType;
  if (TRIGGER_BLOCKS.has(blockType)) return dispatchTrigger(ctx);

  const handler = FIRST_PARTY_DISPATCH[blockType];
  if (handler) return handler(ctx);

  // Catalog-first: a plugin-spawned node resolves via the static catalog even
  // after its manifest was despawned, so it errors "not connected" honestly
  // rather than "manifest not found".
  if (findPluginActionByNodeName(blockType)) return dispatchPluginNode(ctx);

  if (isCustomNodeBlockType(blockType)) return dispatchCustomNode(ctx);

  return { type: 'error', message: `Unknown block type: ${blockType}` };
};

export type { Dispatcher } from './types';
