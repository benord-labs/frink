import { describe, expect, it } from 'vitest';
import { RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
import type { Task } from '../db/schema';
import { mapTaskToNodeOutput } from './signal-bridge';

function task(partial: Partial<Task>): Task {
  return {
    status: 'cancelled',
    result: null,
    startedAt: new Date('2026-06-04T00:00:00.000Z'),
    completedAt: new Date('2026-06-04T00:00:05.000Z'),
    ...partial,
  } as Task;
}

describe('mapTaskToNodeOutput — cancelled task', () => {
  it('carries the cancel reason onto node_output.error (restart interruption marker survives)', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'cancelled',
        result: { cancelled: true, error: RESTART_INTERRUPTION_REASON },
      }),
    );
    expect(output.status).toBe('cancelled');
    expect(output.error?.message).toBe(RESTART_INTERRUPTION_REASON);
  });

  it('omits error when the cancelled task has none (user cancel without a reason)', () => {
    const output = mapTaskToNodeOutput(task({ status: 'cancelled', result: { cancelled: true } }));
    expect(output.status).toBe('cancelled');
    expect(output.error).toBeUndefined();
  });

  // The cancel is the newest fact about the turn. The cancel writer scrubs agentSignal, but a signal
  // written between that writer's read and its CAS can still coexist — and classifying on it would
  // walk the flow past the very step the user stopped.
  it.each(['done', 'awaiting_input'] as const)(
    'outranks a stale `%s` signal recorded before the Stop',
    (state) => {
      const output = mapTaskToNodeOutput(
        task({
          status: 'cancelled',
          result: { cancelled: true, agentSignal: { state, summary: 'mid-turn' } },
        }),
      );
      expect(output.status).toBe('cancelled');
    },
  );
});

describe('mapTaskToNodeOutput — agentSignal branch', () => {
  // The bridge that carries a genuine awaiting_input signal to a flow PAUSE. A plan agent's
  // awaiting_input (even carrying verification.shouldProceed, a flow-author gate field) maps to a
  // paused node — it is never inferred to be a completion. Guards the no-auto-swallow fix.
  it('maps an awaiting_input signal to a paused node and preserves verification', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: {
          agentSignal: {
            state: 'awaiting_input',
            summary: 'Awaiting the user decision',
            verification: { shouldProceed: true },
          },
        },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.verification).toEqual({ shouldProceed: true });
  });

  it('maps a done signal to a completed node (auto-approve plan advances via done)', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'done',
        result: { agentSignal: { state: 'done', summary: 'Plan complete' } },
      }),
    );
    expect(output.status).toBe('completed');
  });
});

describe('mapTaskToNodeOutput — usage-limit park (needs_attention, no signal)', () => {
  it('pauses the node and surfaces the limit message as the park reason', () => {
    const limitText = "You've hit your limit · resets 2:20pm (Europe/London)";
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: {
          subChatId: 'sc1',
          usageLimit: { message: limitText, at: '2026-06-10T13:13:00Z' },
        },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.summary).toBe(limitText);
  });

  it('leaves outputs untouched for a needs_attention task without usageLimit', () => {
    const output = mapTaskToNodeOutput(task({ status: 'needs_attention', result: {} }));
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.summary).toBeUndefined();
  });

  it('surfaces the apiError message as the park reason (stream-error fallback park)', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: {
          subChatId: 'sc1',
          apiError: { message: 'claude process exited with code 1', status: null, at: 'x' },
        },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.summary).toBe('claude process exited with code 1');
  });

  // The chat Pause button parks with only the userPause marker (no agentSignal) — the watcher
  // must still pause the node, and run surfaces get an honest reason instead of a bare label.
  it('pauses a user-pause park and names it "Paused by user"', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: { subChatId: 'sc1', userPause: { at: '2026-07-13T00:00:00Z' } },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.summary).toBe('Paused by user');
  });

  // A signal recorded MID-turn (recordLinkedTaskSignal keeps status running) can coexist with a
  // user-pause park that CAS-won moments later. The park must win classification — a stale `done`
  // advancing the flow past the user-paused step is the exact failure the correctness gate caught.
  it('a user-pause park overrides a stale mid-stream signal (even done)', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: {
          subChatId: 'sc1',
          userPause: { at: '2026-07-13T00:00:00Z' },
          agentSignal: { state: 'done', summary: 'Work finished' },
        },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.summary).toBe('Paused by user');
  });

  // Transient parks keep agentSignal on the row (the resumed turn reuses it), so unlike user-pause
  // the marker and a stale `done` genuinely coexist on the same result. If the signal won, a turn
  // that died on a 401 right after signalling would advance the flow past a step that never
  // finished — a silently wrong result, worse than the stuck run this park exists to prevent.
  it('an api-error park overrides a mid-turn done signal instead of completing the node', () => {
    const apiErrorText =
      'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: {
          subChatId: 'sc1',
          apiError: { message: apiErrorText, status: 401, at: '2026-07-25T20:39:44Z' },
          agentSignal: { state: 'done', summary: 'Work finished' },
        },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.summary).toBe(apiErrorText);
  });

  it('a usage-limit park overrides a mid-turn done signal too', () => {
    const limitText = "You've hit your limit · resets 2:20pm (Europe/London)";
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: {
          subChatId: 'sc1',
          usageLimit: { message: limitText, at: '2026-07-25T20:39:44Z' },
          agentSignal: { state: 'done', summary: 'Work finished' },
        },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.summary).toBe(limitText);
  });

  // The override is scoped to parks: an UNMARKED needs_attention still classifies on the signal,
  // which is how an agent's own `awaiting_input` question keeps its summary.
  it('still classifies on the signal when no park marker is present', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: {
          subChatId: 'sc1',
          agentSignal: { state: 'awaiting_input', summary: 'Which branch should I target?' },
        },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.summary).toBe('Which branch should I target?');
  });
});

describe('mapTaskToNodeOutput — converging-merge fields (start_task fallback)', () => {
  // The fallback executor writes conflict fields at the TOP LEVEL of task.result, not in
  // structured stdout — the bridge must copy them into outputs or a fallback-path merge
  // conflict is invisible to node_output readers (BatchMonitor run rows).
  it('copies top-level converge-merge fields into outputs on awaiting_input', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'needs_attention',
        result: {
          agentSignal: { state: 'awaiting_input', summary: 'Merge conflict' },
          mergeConflict: true,
          conflictingBranch: 'feat/b',
          conflictedFiles: ['src/x.ts'],
          mergedBranches: ['feat/a'],
        },
      }),
    );
    expect(output.status).toBe('awaiting_input');
    expect(output.outputs?.mergeConflict).toBe(true);
    expect(output.outputs?.conflictingBranch).toBe('feat/b');
    expect(output.outputs?.conflictedFiles).toEqual(['src/x.ts']);
    expect(output.outputs?.mergedBranches).toEqual(['feat/a']);
  });

  it('copies mergedBranches on a clean-merge completion and omits absent fields', () => {
    const output = mapTaskToNodeOutput(
      task({
        status: 'completed',
        result: {
          agentSignal: { state: 'done', summary: 'ok' },
          mergedBranches: ['feat/a'],
        },
      }),
    );
    expect(output.status).toBe('completed');
    expect(output.outputs?.mergedBranches).toEqual(['feat/a']);
    expect(output.outputs?.mergeConflict).toBeUndefined();
  });
});
