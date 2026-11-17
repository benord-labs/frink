import { describe, expect, it } from 'vitest';
import { PLAN_MODE_NO_FINISH_SIGNAL } from '../../../shared/lib/task-agent-lifecycle-prompt';
import {
  buildOperatorReminders,
  buildUserPromptSubmitReminderHook,
  DEBUG_MODE_EXIT_REMINDER,
  PLAN_MODE_EXIT_REMINDER,
  prepareTurnReminders,
  TASK_SIGNAL_DISARMED_REMINDER,
  wrapRemindersForPrompt,
} from './operator-reminders';

const base = {
  mode: 'agent',
  previousMode: undefined as string | undefined,
  hasResumeSession: false,
  taskSignalDisarmed: false,
  agentSawPriorTurns: false,
  planOwesNoFinishSignal: false,
};

describe('buildOperatorReminders', () => {
  it('returns no reminders for a fresh agent turn', () => {
    const { reminders, isExitingDebugMode } = buildOperatorReminders(base);
    expect(reminders).toEqual([]);
    expect(isExitingDebugMode).toBe(false);
  });

  it('states the no-finish-signal duty on a plan turn that owes it, every turn', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      mode: 'plan',
      previousMode: 'plan',
      planOwesNoFinishSignal: true,
    });
    expect(reminders).toEqual([PLAN_MODE_NO_FINISH_SIGNAL]);
  });

  it('adds the plan-exit reminder on plan→agent while resuming', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      previousMode: 'plan',
      hasResumeSession: true,
    });
    expect(reminders).toEqual([PLAN_MODE_EXIT_REMINDER]);
  });

  it('omits the plan-exit reminder without a resumed session (no transcript to correct)', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      previousMode: 'plan',
      hasResumeSession: false,
    });
    expect(reminders).toEqual([]);
  });

  it('omits the plan-exit reminder for back-to-back plan turns', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      mode: 'plan',
      previousMode: 'plan',
      hasResumeSession: true,
    });
    expect(reminders).toEqual([]);
  });

  it('adds the debug-exit reminder and flags isExitingDebugMode on debug→agent while resuming', () => {
    const { reminders, isExitingDebugMode } = buildOperatorReminders({
      ...base,
      previousMode: 'debug',
      hasResumeSession: true,
    });
    expect(reminders).toEqual([DEBUG_MODE_EXIT_REMINDER]);
    expect(isExitingDebugMode).toBe(true);
  });

  it('adds the plan-exit reminder when switching plan→debug — debug turns act too (default/auto)', () => {
    const { reminders, isExitingDebugMode } = buildOperatorReminders({
      ...base,
      mode: 'debug',
      previousMode: 'plan',
      hasResumeSession: true,
    });
    expect(reminders).toEqual([PLAN_MODE_EXIT_REMINDER]);
    expect(isExitingDebugMode).toBe(false);
  });

  it('adds the plan-exit reminder on unknown history (agent turn, resumed) — the tracking map does not survive restarts', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      previousMode: undefined,
      hasResumeSession: true,
    });
    expect(reminders).toEqual([PLAN_MODE_EXIT_REMINDER]);
  });

  it('adds the plan-exit reminder on unknown history for a resumed debug turn too', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      mode: 'debug',
      previousMode: undefined,
      hasResumeSession: true,
    });
    expect(reminders).toEqual([PLAN_MODE_EXIT_REMINDER]);
  });

  it('keeps the plan-exit wording unconditionally true (safe to fire on a chat that never planned)', () => {
    expect(PLAN_MODE_EXIT_REMINDER).not.toMatch(/You have exited/i);
    expect(PLAN_MODE_EXIT_REMINDER).toContain('no longer apply');
  });

  it('adds the disarmed reminder only when the agent saw prior turns', () => {
    expect(
      buildOperatorReminders({ ...base, taskSignalDisarmed: true, agentSawPriorTurns: true })
        .reminders,
    ).toEqual([TASK_SIGNAL_DISARMED_REMINDER]);
    expect(
      buildOperatorReminders({ ...base, taskSignalDisarmed: true, agentSawPriorTurns: false })
        .reminders,
    ).toEqual([]);
  });

  it('leaves the disarmed reminder to the Flow-run-ended notice on the turn that carries it', () => {
    const disarmed = { ...base, taskSignalDisarmed: true, agentSawPriorTurns: true };
    expect(buildOperatorReminders({ ...disarmed, flowRunEndedNoticeDue: true }).reminders).toEqual(
      [],
    );
    expect(buildOperatorReminders({ ...disarmed, flowRunEndedNoticeDue: false }).reminders).toEqual(
      [TASK_SIGNAL_DISARMED_REMINDER],
    );
  });

  it('omits the disarmed reminder in plan mode (read-only — tool-availability wording would mislead)', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      mode: 'plan',
      taskSignalDisarmed: true,
      agentSawPriorTurns: true,
    });
    expect(reminders).not.toContain(TASK_SIGNAL_DISARMED_REMINDER);
  });

  it('stacks multiple reminders (plan-exit + disarmed) in order', () => {
    const { reminders } = buildOperatorReminders({
      mode: 'agent',
      previousMode: 'plan',
      hasResumeSession: true,
      taskSignalDisarmed: true,
      agentSawPriorTurns: true,
      planOwesNoFinishSignal: false,
    });
    expect(reminders).toEqual([PLAN_MODE_EXIT_REMINDER, TASK_SIGNAL_DISARMED_REMINDER]);
  });

  it('keys each reminder stably, so a reminder joining the set leaves the others unchanged', () => {
    const disarmed = {
      ...base,
      hasResumeSession: true,
      taskSignalDisarmed: true,
      agentSawPriorTurns: true,
    };
    const alone = buildOperatorReminders({ ...disarmed, previousMode: 'agent' }).entries;
    const stacked = buildOperatorReminders({ ...disarmed, previousMode: 'plan' }).entries;
    expect(alone).toEqual([
      { key: 'frink_task_signal_disarmed', text: TASK_SIGNAL_DISARMED_REMINDER },
    ]);
    expect(stacked).toEqual([
      { key: 'frink_plan_mode_exit', text: PLAN_MODE_EXIT_REMINDER },
      { key: 'frink_task_signal_disarmed', text: TASK_SIGNAL_DISARMED_REMINDER },
    ]);
  });
});

describe('prepareTurnReminders', () => {
  const due = {
    ...base,
    previousMode: 'plan',
    hasResumeSession: true,
    subChatId: 'sc-1',
    prompt: 'hi',
  };

  it('gives Codex its reminders as host context and leaves the prompt as typed', () => {
    const turn = prepareTurnReminders({ ...due, agentRuntime: 'codex' });
    expect(turn.prompt).toBe('hi');
    expect(turn.codexContext).toEqual({
      frink_plan_mode_exit: { kind: 'application', value: PLAN_MODE_EXIT_REMINDER },
    });
  });

  it('leaves the Claude prompt as typed, its hook reads the reminders', () => {
    const turn = prepareTurnReminders({ ...due, agentRuntime: 'claude' });
    expect(turn.prompt).toBe('hi');
    expect(turn.reminders).toEqual([PLAN_MODE_EXIT_REMINDER]);
    expect(turn.codexContext).toEqual({});
  });

  it.each(['acp', 'copilot', 'cursor'])('prepends the reminders as text on %s', (agentRuntime) => {
    const turn = prepareTurnReminders({ ...due, agentRuntime });
    expect(turn.prompt).toBe(`${wrapRemindersForPrompt([PLAN_MODE_EXIT_REMINDER])}\n\nhi`);
    expect(turn.codexContext).toEqual({});
  });
});

describe('wrapRemindersForPrompt', () => {
  it('wraps each reminder as a <system-reminder> block (text fallback)', () => {
    expect(wrapRemindersForPrompt(['alpha', 'beta'])).toBe(
      '<system-reminder>\nalpha\n</system-reminder>\n\n<system-reminder>\nbeta\n</system-reminder>',
    );
  });
});

describe('buildUserPromptSubmitReminderHook', () => {
  it('returns a hook whose additionalContext joins the reminders (Claude in-conversation system prompt)', async () => {
    const hook = buildUserPromptSubmitReminderHook(['alpha', 'beta']);
    expect(await hook()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'alpha\n\nbeta',
      },
    });
  });
});
