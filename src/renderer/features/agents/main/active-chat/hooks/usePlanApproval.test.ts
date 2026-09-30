// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../../../shared/types/plan';
import { usePlanApproval } from './usePlanApproval';

const { toastError, toastInfo, armApprovedPlanState, setAtom } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  armApprovedPlanState: vi.fn(),
  setAtom: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastError,
    info: toastInfo,
  },
}));

vi.mock('../../../../../lib/jotai-store', () => ({
  appStore: { set: setAtom },
}));

vi.mock('../../../atoms', () => ({
  pendingModeIntentAtomFamily: (subChatId: string) => Symbol.for(`pendingModeIntent:${subChatId}`),
}));

vi.mock('../../../stores/sub-chat-store', () => ({
  armApprovedPlanState,
}));

describe('usePlanApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears pending and toasts when approval is requested but messages have no unapproved frink plan (even if tab is inactive)', () => {
    const setChatMode = vi.fn();
    const scrollToBottom = vi.fn();
    const sendMessage = vi.fn();
    const setPendingBuildPlanSubChatId = vi.fn();

    renderHook(() =>
      usePlanApproval({
        subChatId: 'sub-1',
        messages: [] as unknown as UIMessage[],
        pendingBuildPlanSubChatId: 'sub-1',
        setPendingBuildPlanSubChatId,
        setChatMode,
        scrollToBottom,
        sendMessageRef: { current: sendMessage },
        isResolvedExecutionAccountReady: true,
        isStreaming: false,
      }),
    );

    expect(setPendingBuildPlanSubChatId).toHaveBeenCalledWith(null);
    expect(toastError).toHaveBeenCalledWith(
      'No pending plan found to approve. Refresh and try again.',
    );
    expect(armApprovedPlanState).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not trigger approval flow when pending approval targets another sub-chat', () => {
    const setChatMode = vi.fn();
    const scrollToBottom = vi.fn();
    const sendMessage = vi.fn();
    const setPendingBuildPlanSubChatId = vi.fn();

    renderHook(() =>
      usePlanApproval({
        subChatId: 'sub-1',
        messages: [] as unknown as UIMessage[],
        pendingBuildPlanSubChatId: 'sub-2',
        setPendingBuildPlanSubChatId,
        setChatMode,
        scrollToBottom,
        sendMessageRef: { current: sendMessage },
        isResolvedExecutionAccountReady: true,
        isStreaming: false,
      }),
    );

    expect(setPendingBuildPlanSubChatId).not.toHaveBeenCalled();
    expect(armApprovedPlanState).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('shows an error and does not send when no unapproved plan is present', () => {
    const setChatMode = vi.fn();
    const scrollToBottom = vi.fn();
    const sendMessage = vi.fn();
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'No plan ready for approval.' }],
      },
    ] as unknown as UIMessage[];

    const { result } = renderHook(() =>
      usePlanApproval({
        subChatId: 'sub-1',
        messages,
        pendingBuildPlanSubChatId: null,
        setPendingBuildPlanSubChatId: vi.fn(),
        setChatMode,
        scrollToBottom,
        sendMessageRef: { current: sendMessage },
        isResolvedExecutionAccountReady: true,
        isStreaming: false,
      }),
    );

    act(() => {
      result.current();
    });

    expect(armApprovedPlanState).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'No pending plan found to approve. Refresh and try again.',
    );
  });

  it('stores approved plan context and sends build plan in agent mode', () => {
    const setChatMode = vi.fn();
    const scrollToBottom = vi.fn();
    const sendMessage = vi.fn();

    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: {
              planId: 'plan-1',
              status: 'awaiting_approval',
              summary: 'Do the approved work',
              planPath: '/tmp/approved.plan.md',
              planText: 'Do the approved work',
            },
          },
        ],
      },
    ] as unknown as UIMessage[];

    const sendMessageRef = { current: sendMessage };

    const { result } = renderHook(() =>
      usePlanApproval({
        subChatId: 'sub-1',
        messages,
        pendingBuildPlanSubChatId: null,
        setPendingBuildPlanSubChatId: vi.fn(),
        setChatMode,
        scrollToBottom,
        sendMessageRef,
        isResolvedExecutionAccountReady: true,
        isStreaming: false,
      }),
    );

    act(() => {
      result.current();
    });

    expect(armApprovedPlanState).toHaveBeenCalledWith('sub-1', {
      planId: 'plan-1',
      planText: 'Do the approved work',
    });
    expect(setAtom).toHaveBeenCalledWith(Symbol.for('pendingModeIntent:sub-1'), 'agent');
    expect(setChatMode).toHaveBeenCalledWith('agent');
    expect(scrollToBottom).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      role: 'user',
      parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
    });
  });

  it('refuses to fall back to an older plan when the newest plan has no plan text', () => {
    const sendMessage = vi.fn();
    const planPart = (planId: string, planText?: string) => ({
      role: 'assistant',
      parts: [
        {
          type: 'tool-frink-plan',
          input: {
            planId,
            status: 'awaiting_approval',
            summary: 's',
            planText,
          },
        },
      ],
    });
    const messages = [
      { id: 'older', ...planPart('older-plan', '## Older plan') },
      { id: 'newer', ...planPart('newer-plan') },
    ] as unknown as UIMessage[];

    const { result } = renderHook(() =>
      usePlanApproval({
        subChatId: 'sub-1',
        messages,
        pendingBuildPlanSubChatId: null,
        setPendingBuildPlanSubChatId: vi.fn(),
        setChatMode: vi.fn(),
        scrollToBottom: vi.fn(),
        sendMessageRef: { current: sendMessage },
        isResolvedExecutionAccountReady: true,
        isStreaming: false,
      }),
    );

    act(() => {
      result.current();
    });

    expect(armApprovedPlanState).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'No pending plan found to approve. Refresh and try again.',
    );
  });

  it('no-ops for a flow-driven plan — approval belongs to the flow run panel (no double-fire)', () => {
    const setChatMode = vi.fn();
    const scrollToBottom = vi.fn();
    const sendMessage = vi.fn();
    const setPendingBuildPlanSubChatId = vi.fn();

    const messages = [
      {
        id: 'assistant-flow',
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: {
              planId: 'plan-flow',
              status: 'awaiting_approval',
              summary: 'Flow plan',
              flowDriven: true,
              planText: '## Flow plan',
            },
          },
        ],
      },
    ] as unknown as UIMessage[];

    const { result } = renderHook(() =>
      usePlanApproval({
        subChatId: 'sub-1',
        messages,
        pendingBuildPlanSubChatId: null,
        setPendingBuildPlanSubChatId,
        setChatMode,
        scrollToBottom,
        sendMessageRef: { current: sendMessage },
        isResolvedExecutionAccountReady: true,
        isStreaming: false,
      }),
    );

    act(() => {
      result.current();
    });

    // Does NOT continue the chat turn: no approved-context store, no mode flip, no send.
    expect(armApprovedPlanState).not.toHaveBeenCalled();
    expect(setChatMode).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(
      'This plan belongs to a Flow run — reply in the chat or use the Flow run panel.',
    );
    expect(setPendingBuildPlanSubChatId).toHaveBeenCalledWith(null);
  });

  it('keeps an older parked Flow plan owned when a newer assistant message has no plan', () => {
    const setChatMode = vi.fn();
    const sendMessage = vi.fn();
    const messages = [
      {
        id: 'assistant-flow',
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: {
              planId: 'plan-flow',
              status: 'awaiting_approval',
              summary: 'Flow plan',
              flowDriven: true,
              planText: '## Flow plan',
            },
          },
        ],
      },
      {
        id: 'assistant-newer',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Later' }],
      },
    ] as unknown as UIMessage[];

    const { result } = renderHook(() =>
      usePlanApproval({
        subChatId: 'sub-1',
        messages,
        pendingBuildPlanSubChatId: null,
        setPendingBuildPlanSubChatId: vi.fn(),
        setChatMode,
        scrollToBottom: vi.fn(),
        sendMessageRef: { current: sendMessage },
        isResolvedExecutionAccountReady: true,
        isStreaming: false,
      }),
    );

    act(() => result.current());

    expect(armApprovedPlanState).not.toHaveBeenCalled();
    expect(setAtom).not.toHaveBeenCalled();
    expect(setChatMode).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not approve when no canonical plan part is present', () => {
    const setChatMode = vi.fn();
    const scrollToBottom = vi.fn();
    const sendMessage = vi.fn();

    const messages = [
      {
        id: 'assistant-legacy',
        role: 'assistant',
        parts: [
          {
            type: 'tool-PlanWrite',
            input: { action: 'create' },
            output: { ok: true },
          },
        ],
      },
    ] as unknown as UIMessage[];

    const { result } = renderHook(() =>
      usePlanApproval({
        subChatId: 'sub-legacy',
        messages,
        pendingBuildPlanSubChatId: null,
        setPendingBuildPlanSubChatId: vi.fn(),
        setChatMode,
        scrollToBottom,
        sendMessageRef: { current: sendMessage },
        isResolvedExecutionAccountReady: true,
        isStreaming: false,
      }),
    );

    act(() => {
      result.current();
    });

    expect(armApprovedPlanState).not.toHaveBeenCalled();
    expect(setChatMode).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'No pending plan found to approve. Refresh and try again.',
    );
  });

  it('holds a card approval until the plan turn settles, then sends it once', () => {
    const sendMessage = vi.fn();
    const setPendingBuildPlanSubChatId = vi.fn();
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-frink-plan',
            input: { planId: 'plan-1', status: 'awaiting_approval', planText: 'Do the work' },
          },
        ],
      },
    ] as unknown as UIMessage[];
    const { rerender } = renderHook(
      ({ isStreaming }) =>
        usePlanApproval({
          subChatId: 'sub-1',
          messages,
          pendingBuildPlanSubChatId: 'sub-1',
          setPendingBuildPlanSubChatId,
          setChatMode: vi.fn(),
          scrollToBottom: vi.fn(),
          sendMessageRef: { current: sendMessage },
          isResolvedExecutionAccountReady: true,
          isStreaming,
        }),
      { initialProps: { isStreaming: true } },
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(setPendingBuildPlanSubChatId).not.toHaveBeenCalled();

    rerender({ isStreaming: false });

    expect(setPendingBuildPlanSubChatId).toHaveBeenCalledWith(null);
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
