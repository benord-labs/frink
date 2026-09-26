import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSubagentTaskStatusForTest,
  clearSubagentTasks,
  noteSubagentTaskFrame,
  setSubagentTaskPublisher,
} from './subagent-task-status';

const started = (extra: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    subagent_type: 'general-purpose',
    ...extra,
  }) as unknown as SDKMessage;

const notification = (extra: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    status: 'completed',
    ...extra,
  }) as unknown as SDKMessage;

describe('subagent-task-status', () => {
  const publish = vi.fn();

  beforeEach(() => {
    __resetSubagentTaskStatusForTest();
    publish.mockClear();
    setSubagentTaskPublisher(publish);
  });

  it('publishes running:true once per task, not per repeated frame', () => {
    noteSubagentTaskFrame('sub-1', started());
    noteSubagentTaskFrame('sub-1', started());
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      toolCallId: 'tool-1',
      running: true,
    });
  });

  it('retires by task_id even when the terminal notification omits tool_use_id', () => {
    // tool_use_id is optional in the SDK contract; the async terminal frame parses it from a
    // conditionally-written XML tag. The stored correlation value must carry the retraction.
    noteSubagentTaskFrame('sub-1', started());
    noteSubagentTaskFrame('sub-1', notification());
    expect(publish).toHaveBeenLastCalledWith({
      subChatId: 'sub-1',
      toolCallId: 'tool-1',
      running: false,
    });
  });

  it('ignores a notification for an untracked task', () => {
    noteSubagentTaskFrame('sub-1', notification({ task_id: 'unknown' }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('ignores non-agent and housekeeping task starts', () => {
    noteSubagentTaskFrame(
      'sub-1',
      started({ subagent_type: undefined, task_type: 'local_shell', task_id: 'shell-1' }),
    );
    noteSubagentTaskFrame('sub-1', started({ skip_transcript: true, task_id: 'ambient-1' }));
    noteSubagentTaskFrame('sub-1', started({ tool_use_id: undefined, task_id: 'no-tool-1' }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('tracks a task_type agent without subagent_type', () => {
    noteSubagentTaskFrame('sub-1', started({ subagent_type: undefined, task_type: 'local_agent' }));
    expect(publish).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      toolCallId: 'tool-1',
      running: true,
    });
  });

  it('tracks a workflow task from launch to its notification', () => {
    const workflow = { subagent_type: undefined, task_type: 'local_workflow', task_id: 'wf-1' };
    noteSubagentTaskFrame('sub-1', started({ ...workflow, tool_use_id: 'tool-wf' }));
    noteSubagentTaskFrame('sub-1', notification({ task_id: 'wf-1' }));
    expect(publish.mock.calls).toEqual([
      [{ subChatId: 'sub-1', toolCallId: 'tool-wf', running: true }],
      [{ subChatId: 'sub-1', toolCallId: 'tool-wf', running: false }],
    ]);
  });

  it('ignores non-system frames on the hot path', () => {
    noteSubagentTaskFrame('sub-1', { type: 'assistant' } as unknown as SDKMessage);
    noteSubagentTaskFrame('sub-1', { type: 'result' } as unknown as SDKMessage);
    expect(publish).not.toHaveBeenCalled();
  });

  it('clearSubagentTasks publishes running:false for every stranded id, then is idempotent', () => {
    noteSubagentTaskFrame('sub-1', started());
    noteSubagentTaskFrame('sub-1', started({ task_id: 'task-2', tool_use_id: 'tool-2' }));
    publish.mockClear();

    clearSubagentTasks('sub-1');
    expect(publish.mock.calls.map(([p]) => p)).toEqual([
      { subChatId: 'sub-1', toolCallId: 'tool-1', running: false },
      { subChatId: 'sub-1', toolCallId: 'tool-2', running: false },
    ]);

    publish.mockClear();
    clearSubagentTasks('sub-1');
    expect(publish).not.toHaveBeenCalled();
  });

  it('a publisher throw mid-retraction does not strand the remaining ids', () => {
    noteSubagentTaskFrame('sub-1', started());
    noteSubagentTaskFrame('sub-1', started({ task_id: 'task-2', tool_use_id: 'tool-2' }));
    const throwingOnce = vi.fn((payload: { toolCallId: string }) => {
      if (payload.toolCallId === 'tool-1') throw new Error('destroyed webContents');
    });
    setSubagentTaskPublisher(throwingOnce as never);

    clearSubagentTasks('sub-1');
    expect(throwingOnce.mock.calls.map(([p]) => p.toolCallId)).toEqual(['tool-1', 'tool-2']);
  });

  it('swallows a publisher throw — a status signal must never look like a dead SDK stream', () => {
    setSubagentTaskPublisher(() => {
      throw new Error('destroyed webContents');
    });
    expect(() => noteSubagentTaskFrame('sub-1', started())).not.toThrow();
    setSubagentTaskPublisher(publish);
    // The failed publish still recorded the task; teardown retracts it.
    clearSubagentTasks('sub-1');
    expect(publish).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      toolCallId: 'tool-1',
      running: false,
    });
  });
});
