// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, createRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Flags toggled per-test via the mocked module; default both on so the
// destination rows render regardless of launch defaults. `vi.hoisted` makes the
// shared object available inside the hoisted `vi.mock` factory.
const launchFlags = vi.hoisted(() => ({
  flows: true,
  workQueue: true,
  integrations: true,
}));
vi.mock('../../../../../../shared/launch-flags', () => ({
  get LAUNCH_FLAGS() {
    return launchFlags;
  },
}));

import { SidebarNav } from './index';

// Each factory defines its own passthrough locally (a hoisted vi.mock cannot reference an
// out-of-scope const). Passthrough renders children and drops the Radix chrome.
vi.mock('../../../../../components/ui/tooltip', () => {
  const p = ({ children }: { children: ReactNode }) => <>{children}</>;
  return { Tooltip: p, TooltipTrigger: p, TooltipContent: p };
});

// Dropdown content renders inline (no Radix portal/pointer dance); item -> button firing onSelect,
// so the split-mode New Chat menu logic is unit-testable deterministically.
vi.mock('../../../../../components/ui/dropdown-menu', () => {
  const p = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: p,
    DropdownMenuTrigger: p,
    DropdownMenuContent: p,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled,
    }: {
      children: ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
  };
});

const WORK_QUEUE_RUNNING_LABEL_REGEX =
  /Work Queue\. Inbox 0 - Needs attention 0 - Failed 0 - Review 0 - Running 1\. Click to open\./;
const WORK_QUEUE_EMPTY_LABEL_REGEX =
  /Work Queue\. Inbox 0 - Needs attention 0 - Failed 0 - Review 0 - Running 0\. Click to open\./;
const WORK_QUEUE_HAS_MORE_LABEL_REGEX =
  /Work Queue\. Inbox 1 - Needs attention 0 - Failed 0 - Review 2 - Running 3 - More tracked tasks available\. Click to open\./;
afterEach(() => {
  vi.restoreAllMocks();
  launchFlags.flows = true;
  launchFlags.workQueue = true;
  cleanup();
});

function renderNav(overrides?: Partial<ComponentProps<typeof SidebarNav>>) {
  render(
    <SidebarNav
      onNewChat={vi.fn()}
      onViewChats={vi.fn(() => true)}
      onNewFolder={vi.fn()}
      onFlows={vi.fn()}
      onPlugins={vi.fn()}
      onShowWorkQueue={vi.fn()}
      inboxTaskCount={0}
      pendingReviewCount={0}
      runningTaskCount={0}
      needsAttentionTaskCount={0}
      failedTaskCount={0}
      {...overrides}
    />,
  );
}

describe('SidebarNav work queue indicator', () => {
  it.each([
    {
      name: 'review-only work',
      counts: { pendingReviewCount: 2, runningTaskCount: 4 },
      count: '2',
      level: 'review',
    },
    {
      name: 'Inbox and attention work',
      counts: { inboxTaskCount: 2, needsAttentionTaskCount: 1, pendingReviewCount: 3 },
      count: '6',
      level: 'warning',
    },
    {
      name: 'a failure mixed with lower-priority notices',
      counts: { failedTaskCount: 1, needsAttentionTaskCount: 2, pendingReviewCount: 3 },
      count: '6',
      level: 'error',
    },
  ])('shows the actionable total and highest severity for $name', ({ counts, count, level }) => {
    renderNav(counts);
    const notification = screen.getByTestId('work-queue-notification');
    expect(notification.textContent).toBe(count);
    expect(notification.getAttribute('data-level')).toBe(level);
  });

  it('renders no notification for an empty queue or running-only activity', () => {
    renderNav({ runningTaskCount: 1 });
    expect(screen.getByRole('button', { name: WORK_QUEUE_RUNNING_LABEL_REGEX })).toBeTruthy();
    expect(screen.queryByTestId('work-queue-notification')).toBeNull();
    cleanup();
    renderNav();
    expect(screen.getByRole('button', { name: WORK_QUEUE_EMPTY_LABEL_REGEX })).toBeTruthy();
    expect(screen.queryByTestId('work-queue-notification')).toBeNull();
  });

  it('includes has-more suffix when activeTasksHasMore is true', () => {
    renderNav({
      inboxTaskCount: 1,
      pendingReviewCount: 2,
      runningTaskCount: 3,
      activeTasksHasMore: true,
    });
    expect(screen.getByRole('button', { name: WORK_QUEUE_HAS_MORE_LABEL_REGEX })).toBeTruthy();
  });

  it('marks the active destination and forwards its trigger ref', () => {
    const workQueueTriggerRef = createRef<HTMLButtonElement>();
    renderNav({ isWorkQueueActive: true, workQueueTriggerRef });
    const trigger = screen.getByRole('button', { name: WORK_QUEUE_EMPTY_LABEL_REGEX });
    expect(trigger.getAttribute('aria-current')).toBe('page');
    expect(workQueueTriggerRef.current).toBe(trigger);
  });
});

describe('SidebarNav actions', () => {
  it('renders New Chat and New Folder action rows', () => {
    renderNav();
    expect(screen.getByRole('button', { name: 'New Chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Folder' })).toBeTruthy();
  });

  it('renders the Split view row only when onAddSplitPane is provided', () => {
    renderNav();
    expect(screen.queryByRole('button', { name: 'Split view' })).toBeNull();
    cleanup();
    renderNav({ onAddSplitPane: vi.fn() });
    expect(screen.getByRole('button', { name: 'Split view' })).toBeTruthy();
  });

  it.each([
    { prop: 'onNewChat', label: 'New Chat', name: 'New Chat' as string | RegExp },
    { prop: 'onNewFolder', label: 'New Folder', name: 'New Folder' },
    { prop: 'onFlows', label: 'Flows', name: 'Flows' },
    { prop: 'onShowWorkQueue', label: 'Work Queue', name: WORK_QUEUE_EMPTY_LABEL_REGEX },
  ] as const)('fires $prop when the $label row is clicked', ({ prop, name }) => {
    const spy = vi.fn();
    renderNav({ [prop]: spy } as Partial<ComponentProps<typeof SidebarNav>>);
    fireEvent.click(screen.getByRole('button', { name }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('SidebarNav flag gating (hide, not disable)', () => {
  it('hides the Flows row when the flag is off', () => {
    launchFlags.flows = false;
    renderNav();
    expect(screen.queryByRole('button', { name: 'Flows' })).toBeNull();
    expect(screen.getByRole('button', { name: WORK_QUEUE_EMPTY_LABEL_REGEX })).toBeTruthy();
  });

  it('hides the Work Queue row and leaks no badge/dot when the flag is off', () => {
    launchFlags.workQueue = false;
    renderNav({ inboxTaskCount: 5, pendingReviewCount: 2, runningTaskCount: 1 });
    expect(screen.queryByText('5')).toBeNull();
    expect(screen.queryByTestId('work-queue-notification')).toBeNull();
    expect(screen.getByRole('button', { name: 'Flows' })).toBeTruthy();
  });

  it('drops the flag-gated destinations but keeps Plugins, which is never gated', () => {
    launchFlags.flows = false;
    launchFlags.workQueue = false;
    const { container } = render(
      <SidebarNav
        onNewChat={vi.fn()}
        onViewChats={vi.fn(() => true)}
        onNewFolder={vi.fn()}
        onFlows={vi.fn()}
        onPlugins={vi.fn()}
        onShowWorkQueue={vi.fn()}
        inboxTaskCount={0}
        pendingReviewCount={0}
        runningTaskCount={0}
      />,
    );
    // Actions remain (they are not flag-gated)…
    expect(screen.getByRole('button', { name: 'New Chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New Folder' })).toBeTruthy();
    // …the gated destinations are gone…
    expect(screen.queryByRole('button', { name: 'Flows' })).toBeNull();
    expect(screen.queryByRole('button', { name: WORK_QUEUE_EMPTY_LABEL_REGEX })).toBeNull();
    // …but Plugins stays, so the cluster divider stays with it.
    expect(screen.getByRole('button', { name: 'Plugins' })).toBeTruthy();
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('opens Settings on the plugins tab rather than claiming a destination', () => {
    const onPlugins = vi.fn();
    renderNav({ onPlugins });

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(onPlugins).toHaveBeenCalledTimes(1);
  });
});

describe('SidebarNav New Chat split-mode dropdown', () => {
  const splitProps = {
    isSplitActive: true,
    paneChatIds: ['a', 'b'],
    paneLabels: ['Chat A', 'Chat B'],
    activePaneIndex: 0,
    canAddSplitPane: true,
    hasEmptyPane: false,
  };

  it('replaces hidden split choices with View chats while Work Queue is active', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const workQueueTriggerRef = createRef<HTMLButtonElement>();
    const onViewChats = vi.fn(() => true);
    const onNewChat = vi.fn();
    const onAddNewChatPane = vi.fn();
    const onReplacePaneAt = vi.fn();
    renderNav({
      ...splitProps,
      isWorkQueueActive: true,
      onViewChats,
      workQueueTriggerRef,
      onNewChat,
      onAddNewChatPane,
      onReplacePaneAt,
    });

    fireEvent.click(screen.getByRole('button', { name: 'View chats' }));

    expect(onViewChats).toHaveBeenCalledTimes(1);
    expect(onNewChat).not.toHaveBeenCalled();
    expect(onAddNewChatPane).not.toHaveBeenCalled();
    expect(onReplacePaneAt).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'New chat options' })).toBeNull();
    expect(document.activeElement).toBe(workQueueTriggerRef.current);
  });

  it('switches the trigger to a menu affordance ("New chat options") when split is active', () => {
    renderNav(splitProps);
    expect(screen.getByRole('button', { name: 'New chat options' })).toBeTruthy();
    // The single-pane direct "New Chat" action is gone — the row now opens a menu.
    expect(screen.queryByRole('button', { name: 'New Chat' })).toBeNull();
  });

  it('renders New Pane + a Replace row per pane, marking the active pane', () => {
    renderNav({ ...splitProps, activePaneIndex: 1 });
    expect(screen.getByRole('button', { name: 'New Pane' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Replace Pane 1 — Chat A/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Replace Pane 2 — Chat B/ })).toBeTruthy();
    // Active marker sits on pane 2 (index 1).
    expect(screen.getByRole('button', { name: /Replace Pane 2 — Chat B active/ })).toBeTruthy();
  });

  it('fires onAddNewChatPane from New Pane and onReplacePaneAt(index) from a Replace row', () => {
    const onAddNewChatPane = vi.fn();
    const onReplacePaneAt = vi.fn();
    renderNav({ ...splitProps, onAddNewChatPane, onReplacePaneAt });
    fireEvent.click(screen.getByRole('button', { name: 'New Pane' }));
    expect(onAddNewChatPane).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Replace Pane 2 — Chat B/ }));
    expect(onReplacePaneAt).toHaveBeenCalledWith(1);
  });

  it('disables New Pane with "Fill empty pane first" when an empty pane exists', () => {
    const onAddNewChatPane = vi.fn();
    renderNav({ ...splitProps, canAddSplitPane: false, hasEmptyPane: true, onAddNewChatPane });
    expect(screen.getByText('Fill empty pane first')).toBeTruthy();
    const newPane = screen.getByRole('button', { name: /New Pane/ }) as HTMLButtonElement;
    expect(newPane.disabled).toBe(true);
    fireEvent.click(newPane);
    expect(onAddNewChatPane).not.toHaveBeenCalled();
  });

  it('disables New Pane with "Max panes reached" at the pane cap', () => {
    renderNav({ ...splitProps, canAddSplitPane: false, hasEmptyPane: false });
    expect(screen.getByText('Max panes reached')).toBeTruthy();
    expect((screen.getByRole('button', { name: /New Pane/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

/**
 * The Flows dashboard renders beside the sidebar, so it needs the same "you are here" marker and
 * return-to-chats affordance Work Queue has — otherwise the only route back to chat is picking one
 * specific chat, which is the dead end the sidebar was revealed to remove.
 */
describe('SidebarNav flows destination', () => {
  it('marks the Flows row active and forwards its trigger ref', () => {
    const flowsTriggerRef = createRef<HTMLButtonElement>();
    renderNav({ isFlowsActive: true, flowsTriggerRef });

    const trigger = screen.getByRole('button', { name: 'Flows' });
    expect(trigger.getAttribute('aria-current')).toBe('page');
    expect(flowsTriggerRef.current).toBe(trigger);
  });

  it('leaves the Flows row unmarked while the flow editor holds the pane', () => {
    renderNav({ isFlowsActive: false });

    expect(screen.getByRole('button', { name: 'Flows' }).getAttribute('aria-current')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View chats' })).toBeNull();
  });

  it('offers View chats instead of New chat while the Flows dashboard is showing', () => {
    renderNav({ isFlowsActive: true });

    expect(screen.getByRole('button', { name: 'View chats' })).toBeTruthy();
  });

  /** Returning from Flows must restore focus to the Flows row, not Work Queue's trigger. */
  it('restores focus to the Flows row after returning to chats', () => {
    const flowsTriggerRef = createRef<HTMLButtonElement>();
    const workQueueTriggerRef = createRef<HTMLButtonElement>();
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
    renderNav({ isFlowsActive: true, flowsTriggerRef, workQueueTriggerRef });

    fireEvent.click(screen.getByRole('button', { name: 'View chats' }));

    expect(document.activeElement).toBe(flowsTriggerRef.current);
    expect(document.activeElement).not.toBe(workQueueTriggerRef.current);
    rafSpy.mockRestore();
  });

  /** A refused exit (the atom reports no-op) must not steal focus. */
  it('does not move focus when the destination refuses to exit', () => {
    const flowsTriggerRef = createRef<HTMLButtonElement>();
    renderNav({ isFlowsActive: true, flowsTriggerRef, onViewChats: vi.fn(() => false) });

    fireEvent.click(screen.getByRole('button', { name: 'View chats' }));

    expect(document.activeElement).not.toBe(flowsTriggerRef.current);
  });

  /** With the Flows row hidden there is no focus target; returning must still not throw. */
  it('returns to chats without a focus target when the Flows flag is off', () => {
    launchFlags.flows = false;
    const onViewChats = vi.fn(() => true);
    renderNav({ isFlowsActive: true, onViewChats });

    fireEvent.click(screen.getByRole('button', { name: 'View chats' }));

    expect(onViewChats).toHaveBeenCalledTimes(1);
  });
});
