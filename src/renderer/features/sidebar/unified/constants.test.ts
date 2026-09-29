import { describe, expect, it } from 'vitest';
import {
  CHAT_STATE_PRESENTATION,
  getChatActiveState,
  isChatRunning,
  SIDEBAR_ACTIVE_TASK_STATUSES,
  SIDEBAR_STOPPABLE_TASK_STATUSES,
  SIDEBAR_TASK_PRESENTATION,
  SIDEBAR_TRACKED_TASK_STATUSES,
} from './constants';

describe('plan approval presentation', () => {
  it('colours the plan state from the theme-flipping info token, not a per-theme literal', () => {
    for (const [key, className] of Object.entries(CHAT_STATE_PRESENTATION.pendingPlan)) {
      if (!key.endsWith('ClassName')) continue;
      // A `dark:` pair would survive tailwind-merge and leak the wrong theme's colour; --info-fg
      // already flips at the token layer, so one utility covers both themes.
      expect(className).not.toMatch(/dark:/);
    }
    expect(CHAT_STATE_PRESENTATION.pendingPlan.iconClassName).toBe('text-info-fg');
    expect(CHAT_STATE_PRESENTATION.pendingPlan.showPill).toBe(false);
    expect(SIDEBAR_TASK_PRESENTATION.plan_ready.ariaLabel).toBe('Plan awaiting approval');
  });

  it('prioritizes questions, then plans, then running and unseen changes', () => {
    expect(
      getChatActiveState({
        isLoading: true,
        hasPendingQuestion: true,
        hasPendingPlan: true,
        isHeld: true,
        hasUnseenChanges: true,
      }),
    ).toBe('pendingQuestion');
    expect(
      getChatActiveState({
        isLoading: true,
        hasPendingQuestion: false,
        hasPendingPlan: true,
        isHeld: true,
        hasUnseenChanges: true,
      }),
    ).toBe('pendingPlan');
  });

  it('ranks a background wait below a live turn and above unseen changes', () => {
    const idle = { hasPendingQuestion: false, hasPendingPlan: false, hasUnseenChanges: true };
    expect(getChatActiveState({ ...idle, isLoading: true, isHeld: true })).toBe('loading');
    expect(getChatActiveState({ ...idle, isLoading: false, isHeld: true })).toBe('background');
  });
});

describe('SIDEBAR_TASK_PRESENTATION', () => {
  it('uses unambiguous short labels for attention vs failed states', () => {
    expect(SIDEBAR_TASK_PRESENTATION.needs_attention.shortLabel).toBe('Attention');
    expect(SIDEBAR_TASK_PRESENTATION.failed.shortLabel).toBe('Fail');
  });

  it('has a neutral (non-destructive) cancelled pill that is NOT in the queried status list', () => {
    // `cancelled` is display-only — reached via the done→cancelled substitution, never queried (else
    // every historical cancelled task would be dragged into the sidebar payload).
    expect(SIDEBAR_TASK_PRESENTATION.cancelled.label).toBe('Cancelled');
    expect(SIDEBAR_TASK_PRESENTATION.cancelled.textClassName).toContain('muted-foreground');
    expect(SIDEBAR_TASK_PRESENTATION.cancelled.textClassName).not.toContain('destructive');
    expect([...SIDEBAR_TRACKED_TASK_STATUSES]).not.toContain('cancelled');
  });
});

describe('isChatRunning', () => {
  // The fix: a done/"Review" flow chat that receives a follow-up message goes live (chatState
  // 'loading') while its task pill rests on `done` — the left icons must still read as running.
  it('is true when the chat is loading even though the task rests on done', () => {
    expect(isChatRunning('loading', 'done')).toBe(true);
  });

  it('is true for a polled running task with no live chat state', () => {
    expect(isChatRunning(null, 'running')).toBe(true);
  });

  it('is true for a plain (taskless) chat that is loading', () => {
    // Guards the dropped `&& !taskPresentation` clause: a regular chat with no task still reads as
    // running purely from its live `loading` state.
    expect(isChatRunning('loading', undefined)).toBe(true);
  });

  it('is false for an idle done task', () => {
    expect(isChatRunning(null, 'done')).toBe(false);
  });

  it('is false for a non-loading chat state (e.g. awaiting input)', () => {
    expect(isChatRunning('pendingQuestion', 'done')).toBe(false);
  });

  // Between wakes the agent is idle, so a background wait must not pulse or announce "running".
  it('is false for a chat waiting on background work', () => {
    expect(isChatRunning('background', undefined)).toBe(false);
  });

  it('is false while a held question waits on the user, even though the task stays running', () => {
    // A held AskUserQuestion keeps its task `running` in the DB for the whole hold window (see
    // docs/decisions/agent-user-question-mechanism.md) — the row must read "needs you", not "busy".
    expect(isChatRunning('pendingQuestion', 'running')).toBe(false);
  });
});

describe('SIDEBAR_STOPPABLE_TASK_STATUSES', () => {
  // The stop-before-delete gate must exclude `done`: it is finished/awaiting-review and the backend
  // rejects cancelling it, so a done-task chat must delete directly (no dialog, no failed-cancel
  // toast). The display-active set still keeps `done` — it drives the poll + "Ready for review" pill.
  it('excludes `done` while the active set keeps it', () => {
    expect([...SIDEBAR_STOPPABLE_TASK_STATUSES]).not.toContain('done');
    expect([...SIDEBAR_ACTIVE_TASK_STATUSES]).toContain('done');
  });

  it('contains only in-flight, cancellable statuses', () => {
    expect([...SIDEBAR_STOPPABLE_TASK_STATUSES]).toEqual(['pending', 'running', 'plan_ready']);
  });
});
