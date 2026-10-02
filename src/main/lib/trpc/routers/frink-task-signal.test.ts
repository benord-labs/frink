import { describe, expect, it } from 'vitest';
import { TASK_SIGNAL_STATES } from '../../../../shared/types/task-signal';
import {
  buildCodexTaskStopGuardResult,
  buildManualConfirmationResult,
  canApplyTaskSignalForStatus,
  parseTaskSignalInput,
  QUESTION_TEXT_MAX,
  refusePlanModeTerminalSignal,
  resolveTaskSignalTransition,
  TOOL_TASK_SIGNAL_STATES,
  turnOwesTerminalSignal,
} from './frink-task-signal';

describe('buildCodexTaskStopGuardResult', () => {
  it('blocks only the first quiet Stop while an outcome is still owed', () => {
    const blocked = buildCodexTaskStopGuardResult({ stop_hook_active: false }, true);
    expect(blocked.isError).toBe(false);
    expect(JSON.parse(blocked.text)).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('keep waiting'),
    });
    expect(buildCodexTaskStopGuardResult({ stop_hook_active: true }, true).text).toBe('{}');
    expect(buildCodexTaskStopGuardResult({ stop_hook_active: false }, false).text).toBe('{}');
    expect(buildCodexTaskStopGuardResult({}, true).isError).toBe(true);
  });
});

describe('TOOL_TASK_SIGNAL_STATES contract', () => {
  it('is a subset of TASK_SIGNAL_STATES (avoid typos / invalid tool-only states)', () => {
    const shared = new Set(TASK_SIGNAL_STATES);
    for (const s of TOOL_TASK_SIGNAL_STATES) {
      expect(shared.has(s)).toBe(true);
    }
  });
});

describe('parseTaskSignalInput', () => {
  it('accepts tool allowlist states with non-empty summary', () => {
    const parsed = parseTaskSignalInput({
      state: 'done',
      summary: ' Finished ',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.state).toBe('done');
    expect(parsed?.summary).toBe('Finished');
    expect(parsed?.at).toEqual(expect.any(String));
  });

  it('rejects manual_confirmation (not in tool allowlist)', () => {
    expect(
      parseTaskSignalInput({
        state: 'manual_confirmation',
        summary: 'x',
      }),
    ).toBeNull();
  });

  it('rejects missing_completion_signal (not in tool allowlist)', () => {
    expect(
      parseTaskSignalInput({
        state: 'missing_completion_signal',
        summary: 'x',
      }),
    ).toBeNull();
  });

  it('rejects unknown state strings (future TaskSignalState values must be allowlisted)', () => {
    expect(
      parseTaskSignalInput({
        state: 'hypothetical_new_state',
        summary: 'x',
      }),
    ).toBeNull();
  });

  it('rejects empty or whitespace-only summary', () => {
    expect(parseTaskSignalInput({ state: 'done', summary: '' })).toBeNull();
    expect(parseTaskSignalInput({ state: 'done', summary: '   ' })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseTaskSignalInput(null)).toBeNull();
    expect(parseTaskSignalInput('string')).toBeNull();
  });

  it('preserves an object verification', () => {
    const parsed = parseTaskSignalInput({
      state: 'done',
      summary: 'ok',
      verification: { shouldProceed: true },
    });
    expect(parsed?.verification).toEqual({ shouldProceed: true });
  });

  it('omits verification when absent', () => {
    const parsed = parseTaskSignalInput({ state: 'done', summary: 'ok' });
    expect(parsed).not.toBeNull();
    expect(parsed?.verification).toBeUndefined();
  });

  // Regression: a stringified-JSON verification (what the agent sent) must be REJECTED, not
  // silently stripped. Stripping let the canUseTool persist path advance a flow on a
  // verification-less signal while the MCP handler rejected the same call (split-brain).
  it('rejects a stringified-JSON verification', () => {
    expect(
      parseTaskSignalInput({
        state: 'done',
        summary: 'ok',
        verification: '{"shouldProceed": true}',
      }),
    ).toBeNull();
  });

  it('rejects non-object verification (array / number / boolean / null)', () => {
    for (const verification of [[{ shouldProceed: true }], 1, true, null]) {
      expect(parseTaskSignalInput({ state: 'done', summary: 'ok', verification })).toBeNull();
    }
  });

  // Parity with the MCP handler (always strict on details). The old lenient path silently dropped
  // a non-string details and still persisted — the same split-brain class as verification, one field
  // over. The shared schema now rejects it on both paths.
  it('rejects non-string details (number / object / boolean)', () => {
    for (const details of [123, { reason: 'x' }, true]) {
      expect(parseTaskSignalInput({ state: 'done', summary: 'ok', details })).toBeNull();
    }
  });

  it('carries questions on awaiting_input and defaults description/multiSelect', () => {
    const parsed = parseTaskSignalInput({
      state: 'awaiting_input',
      summary: 'need a decision',
      questions: [{ header: 'Path', question: 'Which path?', options: [{ label: 'Now' }] }],
    });
    expect(parsed?.questions).toEqual([
      {
        header: 'Path',
        question: 'Which path?',
        options: [{ label: 'Now', description: '' }],
        multiSelect: false,
      },
    ]);
  });

  // The two producers of `questions` share one parser bound. This is the OTHER one: a question
  // longer than the tool declaration advertises must still park (the declaration deliberately
  // advertises less than the parser accepts), and one past the parser bound must not.
  it('accepts a question longer than the advertised bound but under the parser cap', () => {
    const question = `Which scope? ${'detail '.repeat(120)}`;
    expect(question.length).toBeGreaterThan(500);
    expect(question.length).toBeLessThan(QUESTION_TEXT_MAX);

    const parsed = parseTaskSignalInput({
      state: 'awaiting_input',
      summary: 'need a decision',
      questions: [{ header: 'Scope', question, options: [{ label: 'Now' }] }],
    });

    expect(parsed?.questions?.[0].question).toBe(question);
  });

  it('drops a question past the parser cap but still parks', () => {
    const parsed = parseTaskSignalInput({
      state: 'awaiting_input',
      summary: 'need a decision',
      questions: [
        {
          header: 'Scope',
          question: 'q'.repeat(QUESTION_TEXT_MAX + 1),
          options: [{ label: 'Now' }],
        },
      ],
    });

    expect(parsed?.state).toBe('awaiting_input');
    expect(parsed?.questions).toBeUndefined();
  });

  it('treats an empty questions array as no questions (boundary)', () => {
    const parsed = parseTaskSignalInput({
      state: 'awaiting_input',
      summary: 'need a decision',
      questions: [],
    });
    expect(parsed?.questions).toBeUndefined();
  });

  it('drops questions on a non-pause state (a stray questions on done never reaches the renderer)', () => {
    const parsed = parseTaskSignalInput({
      state: 'done',
      summary: 'done',
      questions: [{ header: 'Path', question: 'Which path?', options: [{ label: 'Now' }] }],
    });
    expect(parsed?.questions).toBeUndefined();
  });

  it('drops a malformed question (e.g. no options) on awaiting_input but still parks', () => {
    const parsed = parseTaskSignalInput({
      state: 'awaiting_input',
      summary: 'need a decision',
      questions: [{ header: 'Path', question: 'Which path?', options: [] }],
    });
    // The signal still parses (the task parks); only the invalid clickable options are dropped.
    expect(parsed?.state).toBe('awaiting_input');
    expect(parsed?.questions).toBeUndefined();
  });

  it('ignores a malformed stray questions on a terminal state (never blocks completion)', () => {
    const parsed = parseTaskSignalInput({
      state: 'done',
      summary: 'finished',
      questions: [{ junk: true }, 42, 'nope'],
    });
    expect(parsed?.state).toBe('done');
    expect(parsed?.questions).toBeUndefined();
  });

  it('ignores a NON-array questions on a terminal state (object/string never fails the signal)', () => {
    for (const questions of [{ q: 1 }, 'nope', 42]) {
      const parsed = parseTaskSignalInput({ state: 'done', summary: 'finished', questions });
      expect(parsed?.state).toBe('done');
      expect(parsed?.questions).toBeUndefined();
    }
  });

  it('drops a non-array questions on awaiting_input but still parks', () => {
    const parsed = parseTaskSignalInput({
      state: 'awaiting_input',
      summary: 'need input',
      questions: { not: 'an array' },
    });
    expect(parsed?.state).toBe('awaiting_input');
    expect(parsed?.questions).toBeUndefined();
  });
});

describe('resolveTaskSignalTransition', () => {
  it('strips a stale quiet-end marker — any recorded signal supersedes it', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute', quietEndedAt: '2026-07-20T00:00:00.000Z' } },
      { state: 'done', summary: 'Finished', at: '2026-07-20T01:00:00.000Z' },
    );

    expect(transition.result.quietEndedAt).toBeUndefined();
    expect(transition.result.startMode).toBe('execute');
  });

  // The expiry park is itself a signal, so it is what retires the hold's crash marker (sc-1313).
  it('strips the held-question marker — a later boot must not resurrect a parked question', () => {
    const transition = resolveTaskSignalTransition(
      { result: { subChatId: 'sc-1', heldQuestions: { 'tu-1': { summary: 'old ask' } } } },
      { state: 'awaiting_input', summary: 'Needs your input', at: '2026-10-02T00:00:00.000Z' },
    );

    expect(transition.result.heldQuestions).toBeUndefined();
    expect(transition.result.subChatId).toBe('sc-1');
  });

  it('maps awaiting_input to needs_attention with signal metadata', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute' } },
      {
        state: 'awaiting_input',
        summary: 'Need confirmation',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('needs_attention');
    expect(transition.result).toEqual(
      expect.objectContaining({
        startMode: 'execute',
        agentSignal: expect.objectContaining({
          state: 'awaiting_input',
          summary: 'Need confirmation',
        }),
      }),
    );
  });

  // `verification.shouldProceed` is a flow-author evaluate->condition gate field, NOT a plan-ready
  // marker. An `awaiting_input` carrying it is still a genuine pause and MUST reach needs_attention
  // (the flow pauses) — even on an auto-approve plan node. Guards the regression where the executor
  // rewrote such a signal to `done` and advanced the flow past a real question.
  it('keeps awaiting_input as needs_attention even with verification.shouldProceed=true', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'plan', skipReview: true } },
      {
        state: 'awaiting_input',
        summary: 'Awaiting the user decision',
        verification: { shouldProceed: true },
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('needs_attention');
    expect(transition.result.agentSignal).toEqual(
      expect.objectContaining({ state: 'awaiting_input', verification: { shouldProceed: true } }),
    );
  });

  it('maps failed to failed and sets result.error', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute' } },
      {
        state: 'failed',
        summary: 'Command failed',
        details: 'Exit code 1',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('failed');
    expect(transition.result.error).toBe('Exit code 1');
  });

  it('maps done to plan_ready for plan mode when skipReview is false', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'plan', skipReview: false } },
      {
        state: 'done',
        summary: 'Plan complete',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('plan_ready');
  });

  // Auto-approve advance preserved after removing the awaiting_input->done rewrite: a plan node with
  // skipReview that signals `done` (the plan-card path) still resolves `done` and advances — it does
  // NOT pause at plan_ready. The counterpart guarantee to "awaiting_input always pauses".
  it('maps done to done for plan mode when skipReview is true (auto-approve advances)', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'plan', skipReview: true } },
      { state: 'done', summary: 'Plan complete', at: '2026-01-01T00:00:00.000Z' },
    );

    expect(transition.status).toBe('done');
  });

  it('coerces a stray completed to done for plan mode when skipReview is true', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'plan', skipReview: true } },
      { state: 'completed', summary: 'Plan complete', at: '2026-01-01T00:00:00.000Z' },
    );

    expect(transition.status).toBe('done');
  });

  it('maps done to done for execute mode', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute' } },
      {
        state: 'done',
        summary: 'Execution complete',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('done');
  });

  it('coerces a stray completed signal to done for execute mode (completed is no longer agent-callable)', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute' } },
      {
        state: 'completed',
        summary: 'Summary task complete',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('done');
  });

  it('coerces a stray completed signal to plan_ready in plan mode', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'plan', skipReview: false } },
      { state: 'completed', summary: 'Plan complete', at: '2026-01-01T00:00:00.000Z' },
    );

    expect(transition.status).toBe('plan_ready');
  });

  it('normalizes a coerced completed signal to done in the STORED agentSignal', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute' } },
      { state: 'completed', summary: 'done', at: '2026-01-01T00:00:00.000Z' },
    );
    expect(transition.status).toBe('done');
    // Downstream readers of agentSignal.state must not see 'completed' (would skip the review gate).
    expect((transition.result.agentSignal as { state: string }).state).toBe('done');
  });

  it('maps completed signal to plan_ready for plan mode when skipReview is false', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'plan', skipReview: false } },
      {
        state: 'completed',
        summary: 'Plan summary complete',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('plan_ready');
  });

  it('maps missing_completion_signal to needs_attention', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute' } },
      {
        state: 'missing_completion_signal',
        summary: 'Run ended without explicit task signal',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('needs_attention');
  });

  it('clears stale error when transitioning to needs_attention', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute', error: 'Old failure' } },
      {
        state: 'awaiting_input',
        summary: 'Need confirmation',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('needs_attention');
    expect(transition.result.error).toBeUndefined();
  });

  it('clears stale error when transitioning to done status', () => {
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'execute', error: 'Old failure' } },
      {
        state: 'done',
        summary: 'Recovered and complete',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('done');
    expect(transition.result.error).toBeUndefined();
  });

  it('clears a stale usage-limit park marker on the next signal (resumed turn must not re-report it)', () => {
    const transition = resolveTaskSignalTransition(
      {
        result: {
          startMode: 'execute',
          usageLimit: { message: "You've hit your limit · resets 2:20pm", at: '2026-06-10' },
        },
      },
      { state: 'done', summary: 'Resumed and complete', at: '2026-06-10T14:30:00.000Z' },
    );

    expect(transition.status).toBe('done');
    expect(transition.result.usageLimit).toBeUndefined();
  });
});

describe('buildManualConfirmationResult', () => {
  it('builds manual_confirmation payload with optional details', () => {
    const result = buildManualConfirmationResult(
      { foo: 'bar' },
      'Denied by user',
      '2026-01-01T00:00:00.000Z',
    );

    expect(result).toEqual({
      foo: 'bar',
      agentSignal: {
        state: 'manual_confirmation',
        summary: 'User responded to AskUserQuestion',
        details: 'Denied by user',
        at: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('strips a stale usage-limit park marker (AskUserQuestion resume path)', () => {
    const result = buildManualConfirmationResult(
      { foo: 'bar', usageLimit: { message: "You've hit your limit", at: '2026-06-10' } },
      undefined,
      '2026-06-10T14:30:00.000Z',
    );

    expect(result.usageLimit).toBeUndefined();
    expect(result.foo).toBe('bar');
  });
});

describe('canApplyTaskSignalForStatus', () => {
  it('allows running tasks', () => {
    expect(canApplyTaskSignalForStatus({ status: 'running', result: {} })).toBe(true);
  });

  it('allows lease-expired stale failures', () => {
    expect(
      canApplyTaskSignalForStatus({
        status: 'failed',
        result: {
          failureCode: 'EXECUTION_LEASE_EXPIRED',
          staleExecution: true,
          error: 'Execution lease expired (no heartbeat)',
        },
      }),
    ).toBe(true);
  });

  it('rejects unrelated failed tasks', () => {
    expect(
      canApplyTaskSignalForStatus({
        status: 'failed',
        result: { failureCode: 'OTHER_FAILURE', error: 'Some other failure' },
      }),
    ).toBe(false);
  });

  it('allows lease-expired failure detected by staleExecution+error string fallback', () => {
    expect(
      canApplyTaskSignalForStatus({
        status: 'failed',
        result: {
          staleExecution: true,
          error: 'Execution lease expired (no heartbeat)',
        },
      }),
    ).toBe(true);
  });

  it('rejects failed task with staleExecution=true but unrelated error string', () => {
    expect(
      canApplyTaskSignalForStatus({
        status: 'failed',
        result: { staleExecution: true, error: 'Something unrelated' },
      }),
    ).toBe(false);
  });

  it('rejects malformed stringified JSON result', () => {
    expect(
      canApplyTaskSignalForStatus({
        status: 'failed',
        result: '{"failureCode":"EXECUTION_LEASE_EXPIRED"',
      }),
    ).toBe(false);
  });

  it('rejects failed task when result is non-object (e.g. number)', () => {
    expect(canApplyTaskSignalForStatus({ status: 'failed', result: 123 })).toBe(false);
  });

  it('rejects completed tasks', () => {
    expect(canApplyTaskSignalForStatus({ status: 'completed', result: {} })).toBe(false);
  });

  it('rejects done tasks', () => {
    expect(canApplyTaskSignalForStatus({ status: 'done', result: {} })).toBe(false);
  });

  it('rejects needs_attention tasks', () => {
    expect(canApplyTaskSignalForStatus({ status: 'needs_attention', result: {} })).toBe(false);
  });

  it('rejects pending tasks', () => {
    expect(canApplyTaskSignalForStatus({ status: 'pending', result: {} })).toBe(false);
  });
});

describe('resolveTaskSignalTransition clears stale lease-expired error on override', () => {
  it('clears EXECUTION_LEASE_EXPIRED error when agent signals done', () => {
    const transition = resolveTaskSignalTransition(
      {
        result: {
          startMode: 'execute',
          executionLeaseId: 'lease-123',
          error: 'Execution lease expired (no heartbeat)',
          failureCode: 'EXECUTION_LEASE_EXPIRED',
          staleExecution: true,
        },
      },
      { state: 'done', summary: 'Task completed successfully', at: '2026-01-01T00:00:00.000Z' },
    );

    expect(transition.status).toBe('done');
    expect(transition.result.error).toBeUndefined();
    expect(transition.result.failureCode).toBeUndefined();
    expect(transition.result.staleExecution).toBeUndefined();
    expect(transition.result.staleDetectedAt).toBeUndefined();
    expect(transition.result.lastHeartbeatAt).toBeUndefined();
    expect(transition.result.agentSignal).toEqual(
      expect.objectContaining({ state: 'done', summary: 'Task completed successfully' }),
    );
    expect(transition.result.executionLeaseId).toBe('lease-123');
  });

  it('clears stale error when agent signals completed (coerced to done)', () => {
    const transition = resolveTaskSignalTransition(
      {
        result: {
          startMode: 'execute',
          error: 'Execution lease expired (no heartbeat)',
          failureCode: 'EXECUTION_LEASE_EXPIRED',
          staleExecution: true,
        },
      },
      {
        state: 'completed',
        summary: 'All tasks done',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('done');
    expect(transition.result.error).toBeUndefined();
    expect(transition.result.failureCode).toBeUndefined();
    expect(transition.result.staleExecution).toBeUndefined();
  });

  it('sets new error when agent signals failed after lease expiry', () => {
    const transition = resolveTaskSignalTransition(
      {
        result: {
          startMode: 'execute',
          error: 'Execution lease expired (no heartbeat)',
          failureCode: 'EXECUTION_LEASE_EXPIRED',
          staleExecution: true,
        },
      },
      {
        state: 'failed',
        summary: 'Agent actually failed',
        details: 'Real error reason',
        at: '2026-01-01T00:00:00.000Z',
      },
    );

    expect(transition.status).toBe('failed');
    expect(transition.result.error).toBe('Real error reason');
  });
});

describe('refusePlanModeTerminalSignal', () => {
  const TERMINALS = TOOL_TASK_SIGNAL_STATES.filter((s) => s !== 'awaiting_input');

  it('refuses every terminal state while the plan is unsubmitted', () => {
    for (const state of TERMINALS) {
      const refusal = refusePlanModeTerminalSignal(state, true);
      expect(refusal, state).toBeTruthy();
      expect(refusal).toContain('ExitPlanMode');
    }
  });

  it('permits awaiting_input in plan mode — it parks, it does not terminalize', () => {
    expect(refusePlanModeTerminalSignal('awaiting_input', true)).toBeNull();
  });

  it('permits every state once the plan is submitted', () => {
    // An auto-approved node implements in-turn after ExitPlanMode and must signal a real `done`
    // for the flow node to advance; keeping the lock on would strand it.
    for (const state of TOOL_TASK_SIGNAL_STATES) {
      expect(refusePlanModeTerminalSignal(state, false), state).toBeNull();
    }
  });

  it('names awaiting_input as the way to ask, so a refused agent has somewhere to go', () => {
    expect(refusePlanModeTerminalSignal('done', true)).toContain('awaiting_input');
  });
});

describe('turnOwesTerminalSignal', () => {
  const owes = (
    planMode: boolean,
    planAutoApprove: boolean,
    planTerminalsLocked: boolean,
  ): boolean => turnOwesTerminalSignal(planMode, planAutoApprove, { planTerminalsLocked });

  it('demands a signal from an ordinary agent turn', () => {
    expect(owes(false, false, false)).toBe(true);
  });

  it('exempts a plan-drafting turn — ExitPlanMode is its terminal artifact', () => {
    // Chasing here is what deadlocked agents legitimately paused mid-plan (e.g. waiting on a
    // background critique): they have nothing to signal until the plan exists.
    expect(owes(true, false, true)).toBe(false);
    expect(owes(true, true, true)).toBe(false);
  });

  it('demands a signal from an auto-approve node that already submitted its plan', () => {
    // The regression this predicate exists for: the node keeps implementing in the SAME turn while
    // the registered mode still reads `plan`, so keying on mode alone leaves it unchased and the
    // flow hangs until the 45-minute idle sweep parks it.
    expect(owes(true, true, false)).toBe(true);
  });

  it('exempts a strict plan node after submission — it halts for human approval, not a signal', () => {
    expect(owes(true, false, false)).toBe(false);
  });

  it('exempts an agent turn that entered plan mode mid-stream', () => {
    // `planMode` is fixed at turn start and cannot see a mid-turn EnterPlanMode; the lock can.
    // Without the lock leading, the hook would chase a signal the persist seam then refuses.
    expect(owes(false, false, true)).toBe(false);
  });

  it('is the exact turn-level inverse of refusePlanModeTerminalSignal for terminal states', () => {
    for (const locked of [true, false]) {
      const refused = refusePlanModeTerminalSignal('done', locked) !== null;
      expect(owes(true, true, locked)).toBe(!refused);
    }
  });
});

describe('plan-mode park vs the auto-approve gate', () => {
  it('parks on awaiting_input even when skipReview is set', () => {
    // skipReview only reaches resolveTaskDoneStatus, which awaiting_input never gets to — an
    // auto-approve node must still be able to stop and ask.
    const transition = resolveTaskSignalTransition(
      { result: { startMode: 'plan', skipReview: true } },
      { state: 'awaiting_input', summary: 'Neon or sqlite?', at: '2026-01-01T00:00:00.000Z' },
    );
    expect(transition.status).toBe('needs_attention');
  });
});
