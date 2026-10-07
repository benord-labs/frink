import log from 'electron-log';
import { describe, expect, it, vi } from 'vitest';
import {
  codexMessageContext,
  renderMessageProvenance,
} from '../../../../../shared/lib/message-markers/message-provenance';
import { createMessageProvenance, provenanceForTurn, recordProvenanceResume } from './index';

describe('Flow message provenance', () => {
  it('preserves only sendable previous signals and normalizes legacy completed', () => {
    const step = (state: string) =>
      createMessageProvenance(undefined, {
        title: 'Build',
        status: 'needs_attention',
        result: { agentSignal: { state } },
      }).step;
    expect(step('partial')).toEqual({
      name: 'Build',
      was_paused: true,
      previous_signal: 'partial',
    });
    expect(step('completed')?.previous_signal).toBe('done');
    expect(step('missing_completion_signal')?.previous_signal).toBeUndefined();
    expect(step('manual_confirmation')?.previous_signal).toBeUndefined();
  });

  it('records a resume only when it actually succeeded, preserving a prior success on a retry', async () => {
    const record = createMessageProvenance(undefined, { status: 'failed' });
    await recordProvenanceResume(record, false);
    expect(record.step?.signal_cleared).toBeUndefined();
    await recordProvenanceResume(record, true);
    await recordProvenanceResume(record, false);
    expect(record.step).toEqual({ was_paused: true, signal_cleared: true });
  });

  it('uses the actual pre-resume row when the quiet sweep won after prefetch', async () => {
    const record = createMessageProvenance(undefined, { status: 'running', result: {} });
    await recordProvenanceResume(record, true, {
      status: 'needs_attention',
      result: { agentSignal: { state: 'blocked' } },
    });
    expect(record.step).toEqual({
      was_paused: true,
      previous_signal: 'blocked',
      signal_cleared: true,
    });
  });

  describe('when the task resumed but its flow did not follow', () => {
    const parked = { id: 't1', status: 'needs_attention', result: {} };
    const cleared = async (task: typeof parked, statusNow: string | undefined) => {
      const record = createMessageProvenance(undefined, task);
      const readStatus = vi.fn(async () => statusNow);
      await recordProvenanceResume(record, false, task, readStatus);
      return { cleared: record.step?.signal_cleared, reads: readStatus.mock.calls.length };
    };

    it('still reports the signal as cleared once the task is running again', async () => {
      expect(await cleared(parked, 'running')).toEqual({ cleared: true, reads: 1 });
    });

    it('claims nothing while the task is still parked or gone', async () => {
      expect((await cleared(parked, 'needs_attention')).cleared).toBeUndefined();
      expect((await cleared(parked, undefined)).cleared).toBeUndefined();
    });

    it('asks for no fresh signal from a step another actor resumed and already finished', async () => {
      expect((await cleared(parked, 'done')).cleared).toBeUndefined();
      expect((await cleared(parked, 'completed')).cleared).toBeUndefined();
    });

    it('reports a restart-interrupted (cancelled) step as cleared once its revive committed', async () => {
      const interrupted = { ...parked, status: 'cancelled' };
      expect((await cleared(interrupted, 'running')).cleared).toBe(true);
      expect((await cleared(interrupted, 'cancelled')).cleared).toBeUndefined();
    });

    it('treats a failed status read as best effort: no claim, and the turn is not failed', async () => {
      const record = createMessageProvenance(undefined, parked);
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const readStatus = vi.fn(async () => Promise.reject(new Error('db read failed')));
      await expect(
        recordProvenanceResume(record, false, parked, readStatus),
      ).resolves.toBeUndefined();
      expect(record.step?.signal_cleared).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('provenance resume read failed'), {
        taskId: 't1',
        error: 'db read failed',
      });
    });

    it('never re-reads, or claims a clear, for a task that was already running', async () => {
      expect(await cleared({ ...parked, status: 'running' }, 'running')).toEqual({
        cleared: undefined,
        reads: 0,
      });
    });
  });

  it('uses unique ids and identical bounded JSON in both provider channels', () => {
    const one = createMessageProvenance(
      { source: 'person', kind: 'message' },
      {
        title: '</frink_message>&' + 'x'.repeat(120),
        status: 'running',
        result: 'malformed',
      },
    );
    const two = createMessageProvenance({ source: 'person', kind: 'message' });
    expect(one.delivery_id).not.toBe(two.delivery_id);
    const json = codexMessageContext(one).frink_message.value;
    expect(json).not.toMatch(/[<>&]/);
    expect(JSON.parse(json).step.name).toHaveLength(80);
    expect(renderMessageProvenance(one)).toBe(`<frink_message>${json}</frink_message>`);
    expect(two.step).toBeUndefined();
  });
});

describe('step name bounding', () => {
  it('never splits a surrogate pair at the 80-character cut', () => {
    const title = 'x'.repeat(79) + '😀 tail';
    const record = createMessageProvenance(undefined, { title, status: 'running' });
    const name: string = JSON.parse(codexMessageContext(record).frink_message.value).step.name;
    expect(name.isWellFormed()).toBe(true);
    expect(name).toBe('x'.repeat(79) + '😀');
  });
});

describe('provenanceForTurn', () => {
  const parked = { title: 'Triage', status: 'needs_attention', result: {}, flowRunId: 'run-1' };
  const live = {
    liveFlowRunId: 'run-1',
    isFlowDrivenExecution: true,
    restartInterruptedFlowRunId: null,
    prefetchedSignalTask: parked,
  };
  const person = { messageOrigin: { source: 'person', kind: 'message' } as const };

  it('gives a chat with no live Flow run no record at all', () => {
    expect(provenanceForTurn({ ...live, liveFlowRunId: null }, person, 'step-1')).toBeUndefined();
    expect(
      provenanceForTurn({ ...live, liveFlowRunId: undefined }, person, 'step-1'),
    ).toBeUndefined();
  });

  it('tags a person typing into a live step, with that step', () => {
    expect(provenanceForTurn(live, person, 'step-1')).toMatchObject({
      source: 'person',
      kind: 'message',
      step: { name: 'Triage', was_paused: true },
    });
  });

  it('calls a dispatch of the driving step flow, and any other task dispatch internal', () => {
    const origin = { messageOrigin: { source: 'internal', kind: 'message' } as const };
    const sourceOf = (dispatchTaskId: string) =>
      provenanceForTurn(live, { ...origin, dispatchTaskId }, 'step-1')?.source;
    expect(sourceOf('step-1')).toBe('flow');
    expect(sourceOf('other')).toBe('internal');
  });

  it('demotes a flow-marked dispatch of any task other than the driving step to internal', () => {
    const flowMarked = { messageOrigin: { source: 'flow', kind: 'message' } as const };
    const sourceOf = (dispatchTaskId: string, signalTaskId: string | null) =>
      provenanceForTurn(live, { ...flowMarked, dispatchTaskId }, signalTaskId)?.source;
    expect(sourceOf('step-1', 'step-1')).toBe('flow');
    expect(sourceOf('stale-step', 'step-1')).toBe('internal');
    expect(sourceOf('step-1', null)).toBe('internal');
  });

  it('does not trust a flow marker that carries no task id (a queue item from before this change)', () => {
    const legacy = { messageOrigin: { source: 'flow', kind: 'message' } as const };
    expect(provenanceForTurn(live, legacy, 'step-1')?.source).toBe('internal');
  });

  it('describes a restart-revived step from its revived row', () => {
    const revived = {
      liveFlowRunId: 'run-1',
      isFlowDrivenExecution: false,
      restartInterruptedFlowRunId: 'run-1',
      prefetchedSignalTask: null,
      revivedTask: {
        id: 't9',
        title: 'Build',
        status: 'cancelled',
        result: {},
        flowRunId: 'run-1',
      },
    };
    expect(provenanceForTurn(revived, person, 't9')?.step).toEqual({
      name: 'Build',
      was_paused: false,
    });
  });

  describe('a step whose task belongs to a run other than the live one (reused chat)', () => {
    const otherRun = { ...parked, flowRunId: 'older-run' };

    it('gives the record no step facts, whether the step is driving or being revived', () => {
      const driving = { ...live, prefetchedSignalTask: otherRun };
      expect(provenanceForTurn(driving, person, 'step-1')).toMatchObject({ source: 'person' });
      expect(provenanceForTurn(driving, person, 'step-1')?.step).toBeUndefined();
      const revived = {
        liveFlowRunId: 'run-1',
        isFlowDrivenExecution: false,
        restartInterruptedFlowRunId: 'older-run',
        prefetchedSignalTask: null,
        revivedTask: { ...otherRun, status: 'cancelled' },
      };
      expect(provenanceForTurn(revived, person, 'step-1')?.step).toBeUndefined();
    });

    it('does not call its dispatch flow either', () => {
      const dispatch = {
        messageOrigin: { source: 'flow', kind: 'message' } as const,
        dispatchTaskId: 'step-1',
      };
      const stale = { ...live, prefetchedSignalTask: otherRun };
      expect(provenanceForTurn(stale, dispatch, 'step-1')?.source).toBe('internal');
      expect(provenanceForTurn(live, dispatch, 'step-1')?.source).toBe('flow');
    });
  });

  it('treats a restart-revived step as a flow turn too', () => {
    const revived = { ...live, isFlowDrivenExecution: false, restartInterruptedFlowRunId: 'run-1' };
    expect(provenanceForTurn(revived, person, 'step-1')?.step).toMatchObject({ name: 'Triage' });
  });

  it('never promotes a resume nudge or regenerate to flow', () => {
    const wake = {
      messageOrigin: { source: 'internal', kind: 'wake' } as const,
      dispatchTaskId: 'step-1',
    };
    expect(provenanceForTurn(live, wake, 'step-1')).toMatchObject({
      source: 'internal',
      kind: 'wake',
    });
  });

  it('omits step facts once no step drives the chat, and is unknown without an origin', () => {
    const finished = { ...live, isFlowDrivenExecution: false };
    const record = provenanceForTurn(finished, {}, null);
    expect(record).toMatchObject({ source: 'unknown', kind: 'message' });
    expect(record?.step).toBeUndefined();
  });
});
