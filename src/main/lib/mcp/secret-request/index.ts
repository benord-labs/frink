/** `frink_request_secret`: ask the user for a secret through Frink's form, never through chat. */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SecretRequest } from '../../../../shared/types/task-signal';
import { handleTaskSignalToolCall, type TaskSignalToolContext } from '../task-signal-tool';
import { type McpToolResult, toolResult } from '../tool-result';
import { SecretRequestError } from './env-file';
import { setLiveSecretRequest } from './store';
import { resolveSecretTarget } from './targets';

const REQUEST_SECRET_TOOL_NAME = 'frink_request_secret';

export const REQUEST_SECRET_TOOL = {
  name: REQUEST_SECRET_TOOL_NAME,
  description:
    'Ask the user for a secret (API key, token, password) without it entering the chat. Frink shows the user a secure form and writes NAME=value straight to the env file; you never see the value. Use this instead of asking the user to paste a secret or edit .env. After calling it, end your turn: you are resumed with "NAME saved to <file>" or "I chose not to save NAME". One secret per turn.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Env variable name, e.g. STRIPE_SECRET_KEY' },
      file: {
        type: 'string',
        description: 'Env file relative to the project folder. Defaults to .env',
      },
      reason: {
        type: 'string',
        description: 'One short sentence telling the user what the secret is for (max 300 chars)',
      },
    },
    required: ['name', 'reason'],
    additionalProperties: false,
  },
};

const argsSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'must be a valid env variable name'),
    file: z.string().min(1).max(200).optional(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();

export type RequestSecretToolContext = TaskSignalToolContext & {
  chatId: string;
  subChatId: string;
  projectPath?: string;
};

/** The execution context lives for one turn, so it marks a turn that already asked. */
const askedThisTurn = new WeakSet<RequestSecretToolContext>();

/**
 * A task-linked turn parks on the request. The park counts only once it is on the task row: a row
 * that refuses it (not running) could not keep it at turn end either, so the request goes live.
 */
async function parkOnTask(ctx: RequestSecretToolContext, request: SecretRequest) {
  if (!ctx.taskSignalEnabled || !ctx.signalTaskId) return false;
  const previous = ctx.latestTaskSignal;
  const signal = { state: 'awaiting_input', summary: `Needs ${request.name}` };
  const result = await handleTaskSignalToolCall(ctx, signal, request);
  if (result.isError || !ctx.latestTaskSignal) return false;
  const { recordLinkedTaskSignal } = await import('../../trpc/routers/frink-task-signal-persist');
  const onRow = await recordLinkedTaskSignal({
    taskIdForExecution: ctx.signalTaskId,
    signal: ctx.latestTaskSignal,
  }).catch(() => false);
  if (!onRow) {
    ctx.latestTaskSignal = previous;
    // Disarmed like a refused signal: the agent was told not to signal, so nothing may chase it.
    ctx.taskSignalEnabled = false;
  }
  return onRow;
}

export async function handleRequestSecretToolCall(
  ctx: RequestSecretToolContext,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return toolResult(`Invalid arguments: ${parsed.error.message}`, true);
  if (askedThisTurn.has(ctx)) {
    return toolResult('One secret per turn. End your turn and ask for the next one later.', true);
  }
  // Claimed before any await: two calls in one assistant message run concurrently.
  askedThisTurn.add(ctx);
  const { name, reason } = parsed.data;
  try {
    const cwd = ctx.projectPath ?? '';
    const target = await resolveSecretTarget(cwd, parsed.data.file ?? '.env', name);
    const request: SecretRequest = {
      id: randomUUID(),
      name,
      chatId: ctx.chatId,
      file: target.rel,
      cwd,
      reason,
      replaces: target.replaces,
      git: target.git,
    };
    if (!(await parkOnTask(ctx, request))) setLiveSecretRequest(ctx.subChatId, request);
    return toolResult(
      `Frink is showing the user a secure form for ${name}. You will never see the value. ` +
        'End your turn now and do not call frink_task_signal. When they save it you will ' +
        `receive "${name} saved to ${request.file}".`,
    );
  } catch (error) {
    askedThisTurn.delete(ctx);
    if (error instanceof SecretRequestError) return toolResult(error.message, true);
    throw error;
  }
}
