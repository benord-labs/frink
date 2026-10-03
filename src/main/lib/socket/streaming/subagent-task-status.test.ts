import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import captured from './__fixtures__/workflow-task-progress.json';
import {
  __resetSubagentTaskStatusForTest,
  clearSubagentTasks,
  ignoreBackgroundTasks,
  listBackgroundRosters,
  listRunningSubagentTasks,
  noteSubagentTaskFrame,
  parseWorkflowProgress,
  readWorkflowProgress,
  setBackgroundRosterPublisher,
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

  // The boot pull a reloaded renderer seeds from: exactly what the push lane last left running.
  describe('listRunningSubagentTasks', () => {
    it('is empty when nothing runs', () => {
      expect(listRunningSubagentTasks()).toEqual([]);
    });

    it('lists every running card across chats, addressed by tool call alone', () => {
      noteSubagentTaskFrame('sub-1', started());
      noteSubagentTaskFrame('sub-2', started({ task_id: 'task-2', tool_use_id: 'tool-2' }));
      expect(listRunningSubagentTasks()).toEqual([
        { subChatId: 'sub-1', toolCallId: 'tool-1', running: true },
        { subChatId: 'sub-2', toolCallId: 'tool-2', running: true },
      ]);
    });

    it('drops a task once its notification retires it', () => {
      noteSubagentTaskFrame('sub-1', started());
      noteSubagentTaskFrame('sub-1', notification());
      expect(listRunningSubagentTasks()).toEqual([]);
    });

    it("drops every one of a chat's tasks when its session detaches", () => {
      noteSubagentTaskFrame('sub-1', started());
      noteSubagentTaskFrame('sub-1', started({ task_id: 'task-2', tool_use_id: 'tool-2' }));
      noteSubagentTaskFrame('sub-2', started({ task_id: 'task-3', tool_use_id: 'tool-3' }));
      clearSubagentTasks('sub-1');
      expect(listRunningSubagentTasks()).toEqual([
        { subChatId: 'sub-2', toolCallId: 'tool-3', running: true },
      ]);
    });
  });
});

// Frames captured from a real two-phase Workflow run against CLI 2.1.278.
describe('workflow progress', () => {
  const frame = (value: unknown) => value as SDKMessage;
  const TASK = captured.running.task_id;

  beforeEach(() => __resetSubagentTaskStatusForTest());

  it('reads phases and agents from a running snapshot', () => {
    noteSubagentTaskFrame('sub-1', frame(captured.running));

    expect(readWorkflowProgress('sub-1', TASK)).toEqual({
      phases: [
        { index: 1, title: 'Alpha' },
        { index: 2, title: 'Beta' },
      ],
      agents: [
        expect.objectContaining({ index: 1, label: 'a1', phaseIndex: 1, state: 'running' }),
        expect.objectContaining({ index: 2, label: 'a2', phaseIndex: 1, state: 'running' }),
      ],
    });
  });

  it('keeps the last snapshot when a frame carries none, then takes the next one', () => {
    noteSubagentTaskFrame('sub-1', frame(captured.running));
    noteSubagentTaskFrame('sub-1', frame(captured.unchanged));
    expect(readWorkflowProgress('sub-1', TASK)?.agents).toHaveLength(2);

    noteSubagentTaskFrame('sub-1', frame(captured.finished));
    const agents = readWorkflowProgress('sub-1', TASK)?.agents ?? [];
    expect(agents.map((a) => [a.label, a.state])).toEqual([
      ['a1', 'done'],
      ['a2', 'done'],
      ['b1', 'done'],
    ]);
    expect(agents[1]).toMatchObject({ durationMs: 22730, activity: 'Bash · sleep 20' });
  });

  it('clears the last snapshot when a present one carries nothing usable', () => {
    noteSubagentTaskFrame('sub-1', frame(captured.running));
    noteSubagentTaskFrame('sub-1', frame({ ...captured.running, workflow_progress: [] }));
    expect(readWorkflowProgress('sub-1', TASK)).toBeNull();

    noteSubagentTaskFrame('sub-1', frame(captured.running));
    noteSubagentTaskFrame('sub-1', frame({ ...captured.running, workflow_progress: [{ x: 1 }] }));
    expect(readWorkflowProgress('sub-1', TASK)).toBeNull();

    noteSubagentTaskFrame('sub-1', frame(captured.running));
    noteSubagentTaskFrame('sub-1', frame({ ...captured.running, workflow_progress: null }));
    expect(readWorkflowProgress('sub-1', TASK)).toBeNull();
  });

  it('forgets a workflow once it finishes, and every workflow when the session detaches', () => {
    noteSubagentTaskFrame('sub-1', frame(captured.running));
    noteSubagentTaskFrame('sub-1', notification({ task_id: TASK }));
    expect(readWorkflowProgress('sub-1', TASK)).toBeNull();

    // No tool_use_id, so the card roster never tracked it; detaching must still drop it.
    noteSubagentTaskFrame('sub-1', frame({ ...captured.running, tool_use_id: undefined }));
    clearSubagentTasks('sub-1');
    expect(readWorkflowProgress('sub-1', TASK)).toBeNull();
  });

  it('dedupes by type and index, last entry winning, and orders by index', () => {
    const view = parseWorkflowProgress([
      { type: 'workflow_agent', index: 2, label: 'b', state: 'start' },
      { type: 'workflow_agent', index: 1, label: 'a', state: 'start', startedAt: 5 },
      { type: 'workflow_agent', index: 2, label: 'b', state: 'error', error: 'stalled' },
    ]);
    expect(view?.agents).toEqual([
      { index: 1, label: 'a', state: 'running', startedAt: 5 },
      { index: 2, label: 'b', state: 'error', error: 'stalled' },
    ]);
  });

  it('lets an unusable last entry retract an earlier one with the same index', () => {
    const view = parseWorkflowProgress([
      { type: 'workflow_phase', index: 1, title: 'Alpha' },
      { type: 'workflow_phase', index: 2, title: 'Beta' },
      { type: 'workflow_phase', index: 2 },
      { type: 'workflow_agent', index: 1, label: 'a', state: 'done' },
      { type: 'workflow_agent', index: 2, label: 'b', state: 'done' },
      { type: 'workflow_agent', index: 2, label: 'b', state: 'paused' },
    ]);
    expect(view?.phases.map((p) => p.title)).toEqual(['Alpha']);
    expect(view?.agents.map((a) => a.label)).toEqual(['a']);
  });

  it('drops anything it does not recognise, and yields nothing when nothing is usable', () => {
    const junk = [
      null,
      'x',
      { type: 'workflow_agent', label: 'no index', state: 'done' },
      { type: 'workflow_agent', index: 1, label: 'odd', state: 'paused' },
      { type: 'workflow_phase', index: 1 },
      { type: 'workflow_log', index: 1, title: 'noise' },
    ];
    expect(parseWorkflowProgress(junk)).toBeNull();
  });

  it('bounds what it keeps', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      type: 'workflow_agent',
      index: i,
      label: 'x'.repeat(500),
      state: 'done',
    }));
    const view = parseWorkflowProgress(many);
    expect(view?.agents).toHaveLength(200);
    expect(view?.agents[0]?.label).toHaveLength(200);

    const phases = Array.from({ length: 80 }, (_, i) => ({
      type: 'workflow_phase',
      index: i,
      title: `p${i}`,
    }));
    expect(parseWorkflowProgress(phases)?.phases).toHaveLength(50);
  });

  it('never throws on a malformed snapshot, and drops the stale one it replaced', () => {
    noteSubagentTaskFrame('sub-1', frame(captured.running));
    const hostile = {
      ...captured.running,
      workflow_progress: [
        {
          get index() {
            throw new Error('x');
          },
        },
      ],
    };
    expect(() => noteSubagentTaskFrame('sub-1', frame(hostile))).not.toThrow();
    expect(readWorkflowProgress('sub-1', TASK)).toBeNull();
  });

  describe('background roster', () => {
    const publishRoster = vi.fn();
    const changed = (tasks: unknown): SDKMessage =>
      ({ type: 'system', subtype: 'background_tasks_changed', tasks }) as unknown as SDKMessage;
    const live = (task_id: string, extra: Record<string, unknown> = {}) => ({
      task_id,
      task_type: 'local_bash',
      description: `${task_id} work`,
      ...extra,
    });
    const roster = (id: string, ambient = false) => ({
      id,
      type: 'local_bash',
      description: `${id} work`,
      ambient,
    });

    beforeEach(() => {
      publishRoster.mockClear();
      setBackgroundRosterPublisher(publishRoster);
    });

    it('replaces the set on every change rather than pairing start and end frames', () => {
      noteSubagentTaskFrame('sub-1', changed([live('a'), live('b', { ambient: true })]));
      noteSubagentTaskFrame('sub-1', changed([live('b', { ambient: true })]));

      expect(publishRoster).toHaveBeenNthCalledWith(1, {
        subChatId: 'sub-1',
        tasks: [roster('a'), roster('b', true)],
      });
      expect(publishRoster).toHaveBeenLastCalledWith({
        subChatId: 'sub-1',
        tasks: [roster('b', true)],
      });
    });

    // A later Stop no longer lists a follower that already left; clearing the verdict before the
    // roster's own removal frame lands would show the follower again.
    it('keeps a dead-follower verdict until its task leaves the roster', () => {
      noteSubagentTaskFrame('sub-1', changed([live('tail1'), live('b2')]));
      ignoreBackgroundTasks('sub-1', new Set(['tail1']));
      ignoreBackgroundTasks('sub-1', new Set());
      expect(publishRoster).toHaveBeenLastCalledWith({ subChatId: 'sub-1', tasks: [roster('b2')] });

      noteSubagentTaskFrame('sub-1', changed([live('b2')]));
      noteSubagentTaskFrame('sub-1', changed([live('tail1'), live('b2')]));
      expect(publishRoster).toHaveBeenLastCalledWith({
        subChatId: 'sub-1',
        tasks: [roster('tail1'), roster('b2')],
      });
    });

    it('never caps the set before the follower filter, so live work behind ignored tasks shows', () => {
      const ids = Array.from({ length: 201 }, (_, i) => `t${i}`);
      noteSubagentTaskFrame('sub-1', changed(ids.map((id) => live(id))));
      ignoreBackgroundTasks('sub-1', new Set(ids.slice(0, 200)));
      expect(publishRoster).toHaveBeenLastCalledWith({
        subChatId: 'sub-1',
        tasks: [roster('t200')],
      });
    });

    it('drops malformed entries and ignores a frame with no list', () => {
      noteSubagentTaskFrame('sub-1', changed('nope'));
      expect(publishRoster).not.toHaveBeenCalled();

      noteSubagentTaskFrame('sub-1', changed([null, { task_id: '' }, live('a')]));
      expect(publishRoster).toHaveBeenLastCalledWith({ subChatId: 'sub-1', tasks: [roster('a')] });
    });

    // The roster re-sends only on a membership change, so a follower the Stop hook drops later must
    // be re-published without it, or it would keep showing for as long as it runs.
    it('hides the Stop hook’s dead followers, re-publishing when the verdict changes', () => {
      noteSubagentTaskFrame('sub-1', changed([live('tail1'), live('b2')]));
      ignoreBackgroundTasks('sub-1', new Set(['tail1']));
      expect(publishRoster).toHaveBeenLastCalledWith({ subChatId: 'sub-1', tasks: [roster('b2')] });

      publishRoster.mockClear();
      ignoreBackgroundTasks('sub-1', new Set(['tail1']));
      expect(publishRoster).not.toHaveBeenCalled();
    });

    // A cut id would match nothing the Stop hook reports, so the dead-follower filter would miss it.
    it('keeps a long task id whole, so the Stop hook can still address it', () => {
      const id = 'x'.repeat(300);
      noteSubagentTaskFrame('sub-1', changed([live(id)]));
      ignoreBackgroundTasks('sub-1', new Set([id]));
      expect(publishRoster).toHaveBeenLastCalledWith({ subChatId: 'sub-1', tasks: [] });
    });

    it('bounds a description without splitting a surrogate pair at the cut', () => {
      const description = `${'a'.repeat(199)}😀tail`;
      noteSubagentTaskFrame('sub-1', changed([live('a', { description })]));
      const [task] = publishRoster.mock.lastCall?.[0].tasks ?? [];
      expect(task.description).toBe('a'.repeat(199));
    });

    it('lists every chat’s visible roster for a reloaded renderer, and forgets a detached one', () => {
      noteSubagentTaskFrame('sub-1', changed([live('tail1'), live('b2')]));
      ignoreBackgroundTasks('sub-1', new Set(['tail1']));
      expect(listBackgroundRosters()).toEqual([{ subChatId: 'sub-1', tasks: [roster('b2')] }]);

      clearSubagentTasks('sub-1');
      expect(listBackgroundRosters()).toEqual([]);
    });

    it('retracts to unknown when the session detaches, since the set is per CLI process', () => {
      noteSubagentTaskFrame('sub-1', changed([live('a')]));
      clearSubagentTasks('sub-1');
      expect(publishRoster).toHaveBeenLastCalledWith({ subChatId: 'sub-1', tasks: null });

      publishRoster.mockClear();
      clearSubagentTasks('sub-1');
      ignoreBackgroundTasks('sub-1', new Set(['a']));
      expect(publishRoster).not.toHaveBeenCalled();
    });
  });
});
