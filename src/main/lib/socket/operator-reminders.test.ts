import { describe, expect, it } from 'vitest';
import { PLAN_MODE_NO_FINISH_SIGNAL } from '../../../shared/lib/task-agent-lifecycle-prompt';
import {
  buildOperatorReminders,
  buildUserPromptSubmitReminderHook,
  DEBUG_MODE_EXIT_REMINDER,
  PLAN_MODE_EXIT_REMINDER,
  TASK_SIGNAL_DISARMED_REMINDER,
  UNDELIVERED_FLOW_STEP_REMINDER,
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
});

describe('wrapRemindersForPrompt', () => {
  it('wraps each reminder as a <system-reminder> block (Codex fallback)', () => {
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

describe('buildOperatorReminders — undelivered flow step (sc-2775)', () => {
  it('explains the missing signal tool instead of claiming the task is over, even on a first turn', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      taskSignalDisarmed: true,
      undeliveredFlowStep: true,
    });
    expect(reminders).toEqual([UNDELIVERED_FLOW_STEP_REMINDER]);
  });

  it('stays silent in plan mode, like the disarmed notice', () => {
    const { reminders } = buildOperatorReminders({
      ...base,
      mode: 'plan',
      previousMode: 'plan',
      taskSignalDisarmed: true,
      undeliveredFlowStep: true,
    });
    expect(reminders).toEqual([]);
  });
});
