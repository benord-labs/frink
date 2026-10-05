/**
 * Shared adapter for the three shell-style block types (start_task, run_command,
 * custom_node / custom-node-as-blockType). All build a `FlowExecuteStepPayload`,
 * call `executeFlowStepLocal`, and translate the result into a NodeOutput.
 */

import type { NodeOutput } from '../../../../shared/types/flow';
import type { ParsedStepOutput } from '../../flow-step-executor';
import { executeFlowStepLocal } from '../../flow-step-executor';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min cap matches custom-node ceiling

export type ShellStepInput = {
  flowRunId: string;
  nodeRunId: string;
  blockType: string; // 'start_task' | 'run_command' | <custom-node-name>
  projectId: string;
  command?: string;
  workingDirectory?: 'project_root' | 'trigger_worktree' | 'custom';
  customPath?: string;
  triggerWorktreePath?: string;
  branch?: string;
  baseBranches?: string[];
  mergeStrategy?: string;
  config?: Record<string, unknown>;
  /** custom nodes: `config` before template rendering, for inputs declared `"template": false` */
  authoredConfig?: ShellStepInput['config'];
  chatId?: string;
  subChatId?: string;
  taskId?: string;
  timeoutMs?: number;
};

export async function executeShellStep(
  input: ShellStepInput,
  signal: AbortSignal,
  startedAt: number,
): Promise<NodeOutput> {
  const result: ParsedStepOutput = await executeFlowStepLocal(
    {
      flowRunId: input.flowRunId,
      nodeRunId: input.nodeRunId,
      projectId: input.projectId,
      blockType: input.blockType,
      command: input.command,
      workingDirectory: input.workingDirectory,
      customPath: input.customPath,
      triggerWorktreePath: input.triggerWorktreePath,
      branch: input.branch,
      baseBranches: input.baseBranches,
      mergeStrategy: input.mergeStrategy,
      config: input.config,
      authoredConfig: input.authoredConfig,
      chatId: input.chatId,
      subChatId: input.subChatId,
      taskId: input.taskId,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    signal,
  );

  return {
    status: result.status,
    outputs: result.outputs,
    artifacts: [],
    durationMs: Date.now() - startedAt,
    error: result.error ? { message: result.error, retryable: false } : undefined,
  };
}
