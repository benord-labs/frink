// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../types';
import { ChatListItem } from './ChatListItem';

vi.mock('../../../../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/pane-colors', () => ({
  getPaneColor: () => undefined,
}));

const markTaskCompleteMock = vi.fn();
vi.mock('@/hooks/use-mark-task-complete', () => ({
  useMarkTaskComplete: () => markTaskCompleteMock,
}));

function makeChatItem(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    id: 'chat-1',
    name: 'Test Chat',
    branch: null,
    updatedAt: new Date('2025-06-01'),
    projectId: 'proj-1',
    hasUnseenChanges: false,
    isLoading: false,
    hasPendingPlan: false,
    hasPendingQuestion: false,
    isWorktree: false,
    taskId: null,
    batchId: null,
    pinnedAt: null,
    ...overrides,
  };
}

afterEach(cleanup);

describe('ChatListItem', () => {
  it('replaces the ordinary chat glyph with an info-toned Plan icon and no pill', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ hasPendingPlan: true })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    const status = screen.getByRole('status', { name: 'Plan awaiting approval' });
    expect(status.querySelector('svg')).toBeTruthy();
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('text-info-fg');
    expect(container.querySelector('.lucide-message-square')).toBeNull();
    expect(container.querySelector('.lucide-list-todo')).toBeNull();
    expect(container.querySelector('.h-1\\.5')).toBeNull();
  });

  it('maps task plan_ready to the same Plan icon and suppresses its task pill', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ taskId: 'task-plan' })}
        taskStatus="plan_ready"
        isSelected
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('status', { name: 'Plan awaiting approval' })).toBeTruthy();
    expect(container.querySelector('.lucide-list-todo')).toBeNull();
    expect(container.querySelector('.h-1\\.5')).toBeNull();
  });

  it('keeps a pending question ahead of an ordinary pending plan', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ hasPendingQuestion: true, hasPendingPlan: true })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.queryByRole('status', { name: 'Plan awaiting approval' })).toBeNull();
    expect(container.querySelector('.lucide-message-square')).toBeTruthy();
  });

  it('keeps an ordinary pending plan ahead of the running state', () => {
    render(
      <ChatListItem
        chat={makeChatItem({ hasPendingPlan: true, isLoading: true })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('status', { name: 'Plan awaiting approval' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Agent is running' })).toBeNull();
  });

  it('renders MessageSquare icon for regular chats', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem()} isSelected={false} onClick={vi.fn()} />,
    );
    const svgs = container.querySelectorAll('svg');
    const hasMessageSquare = Array.from(svgs).some((svg) =>
      svg.classList.contains('lucide-message-square'),
    );
    const hasZap = Array.from(svgs).some((svg) => svg.classList.contains('lucide-zap'));
    expect(hasMessageSquare).toBe(true);
    expect(hasZap).toBe(false);
  });

  it('renders task-specific icon for task chats (not chat/lightning)', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ taskId: 'task-123' })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );
    const svgs = container.querySelectorAll('svg');
    const hasZap = Array.from(svgs).some((svg) => svg.classList.contains('lucide-zap'));
    const hasTaskIcon = Array.from(svgs).some((svg) => svg.classList.contains('lucide-list-todo'));
    const hasMessageSquare = Array.from(svgs).some((svg) =>
      svg.classList.contains('lucide-message-square'),
    );
    expect(hasZap).toBe(false);
    expect(hasTaskIcon).toBe(true);
    expect(hasMessageSquare).toBe(false);
  });

  it('renders sr-only "(automated task)" label for task chats', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ taskId: 'task-456' })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe('(automated task)');
  });

  it('does not render sr-only "(automated task)" for regular chats', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem()} isSelected={false} onClick={vi.fn()} />,
    );
    const srOnlyElements = container.querySelectorAll('.sr-only');
    const hasAutomatedTask = Array.from(srOnlyElements).some(
      (el) => el.textContent === '(automated task)',
    );
    expect(hasAutomatedTask).toBe(false);
  });

  it('displays chat name', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ name: 'My Special Chat' })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('My Special Chat');
  });

  it('shows a generating-title placeholder when name is null (async title gen in flight)', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem({ name: null })} isSelected={false} onClick={vi.fn()} />,
    );
    expect(container.textContent).toContain('Generating title');
  });

  it('renders compact task status pill when task-linked chat has status', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ taskId: 'task-1' })}
        taskStatus="running"
        isSelected={false}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Task running');
  });

  it('renders icon activity dot when task-linked chat is running', () => {
    render(
      <ChatListItem
        chat={makeChatItem({ taskId: 'task-run' })}
        taskStatus="running"
        isSelected={false}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByRole('status', { name: 'Task running' })).toBeTruthy();
  });

  it('does not render icon activity dot when task-linked chat is pending', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ taskId: 'task-pend' })}
        taskStatus="pending"
        isSelected={false}
        onClick={vi.fn()}
      />,
    );
    expect(container.querySelector('span[role="status"][aria-label="Task running"]')).toBeNull();
  });

  it('treats a chat with taskStatus but no taskId yet as a task (live flow start, chats query lag)', () => {
    // The polled tasks query surfaces taskStatus ~5s before the un-polled chats query refreshes
    // chat.taskId. taskStatus is only ever set for DB-linked task chats, so it drives the task
    // icon + pill immediately.
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ taskId: null })}
        taskStatus="running"
        isSelected={false}
        onClick={vi.fn()}
      />,
    );
    const svgs = container.querySelectorAll('svg');
    expect(Array.from(svgs).some((svg) => svg.classList.contains('lucide-list-todo'))).toBe(true);
    expect(Array.from(svgs).some((svg) => svg.classList.contains('lucide-message-square'))).toBe(
      false,
    );
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
  });

  it('announces "Task running" (not "Agent is running") for a live flow chat with taskStatus but no taskId yet', () => {
    // The dropped `&& chat.taskId` guard: the polled taskStatus alone now drives the running dot +
    // its a11y label, so a screen reader hears "Task running" the moment the flow agent starts —
    // before the un-polled chats query refreshes chat.taskId.
    render(
      <ChatListItem
        chat={makeChatItem({ taskId: null })}
        taskStatus="running"
        isSelected={false}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByRole('status', { name: 'Task running' })).toBeTruthy();
  });

  it('does not render task icon or pill for a chat with neither taskId nor taskStatus', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem({ taskId: null })} isSelected={false} onClick={vi.fn()} />,
    );
    const svgs = container.querySelectorAll('svg');
    expect(Array.from(svgs).some((svg) => svg.classList.contains('lucide-message-square'))).toBe(
      true,
    );
    expect(Array.from(svgs).some((svg) => svg.classList.contains('lucide-list-todo'))).toBe(false);
    expect(screen.queryByText('Run')).toBeNull();
  });

  it('renders pin menu entry when isPinned and onPin are set', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem()}
        isSelected={false}
        onClick={vi.fn()}
        onPin={vi.fn()}
        isPinned
      />,
    );
    const svgs = container.querySelectorAll('svg');
    const hasPinIcon = Array.from(svgs).some((svg) => svg.classList.contains('lucide-pin'));
    expect(hasPinIcon).toBe(true);
    expect(container.textContent).toContain('Unpin chat');
  });

  it('does not render pin icon when isPinned is false', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem()} isSelected={false} onClick={vi.fn()} isPinned={false} />,
    );
    const svgs = container.querySelectorAll('svg');
    const hasPinIcon = Array.from(svgs).some((svg) => svg.classList.contains('lucide-pin'));
    expect(hasPinIcon).toBe(false);
  });

  it('renders "Pin chat" menu item when onPin handler is provided and chat is not pinned', () => {
    render(
      <ChatListItem
        chat={makeChatItem()}
        isSelected={false}
        onClick={vi.fn()}
        onPin={vi.fn()}
        isPinned={false}
      />,
    );
    expect(screen.getByText('Pin chat')).toBeDefined();
  });

  it('renders "Unpin chat" menu item when chat is already pinned', () => {
    render(
      <ChatListItem
        chat={makeChatItem()}
        isSelected={false}
        onClick={vi.fn()}
        onPin={vi.fn()}
        isPinned
      />,
    );
    expect(screen.getByText('Unpin chat')).toBeDefined();
  });

  it('calls onPin with chat id when pin menu item is clicked', () => {
    const onPin = vi.fn();
    render(
      <ChatListItem
        chat={makeChatItem({ id: 'chat-pin-test' })}
        isSelected={false}
        onClick={vi.fn()}
        onPin={onPin}
        isPinned={false}
      />,
    );
    screen.getByText('Pin chat').click();
    expect(onPin).toHaveBeenCalledWith('chat-pin-test');
  });

  it('renders "Fork chat" menu item when onFork is provided', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem()} isSelected={false} onClick={vi.fn()} onFork={vi.fn()} />,
    );
    expect(container.textContent).toContain('Fork chat');
  });

  it('does not render "Fork chat" when onFork is omitted', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem()} isSelected={false} onClick={vi.fn()} />,
    );
    expect(container.textContent).not.toContain('Fork chat');
  });

  it('renders actions menu when onFork is the only action handler', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem()} isSelected={false} onClick={vi.fn()} onFork={vi.fn()} />,
    );
    expect(container.textContent).toContain('Fork chat');
  });

  it('does not render actions menu when no action handlers are given', () => {
    const { container } = render(
      <ChatListItem chat={makeChatItem()} isSelected={false} onClick={vi.fn()} />,
    );
    expect(container.textContent).not.toContain('Fork chat');
    expect(container.textContent).not.toContain('Rename');
    expect(container.textContent).not.toContain('Archive chat');
    expect(container.textContent).not.toContain('Delete chat permanently');
  });

  it('renders "Mark complete" only for a done task chat and accepts on click', () => {
    markTaskCompleteMock.mockReset();
    render(
      <ChatListItem
        chat={makeChatItem({ taskId: 'task-123' })}
        isSelected={false}
        onClick={vi.fn()}
        onRename={vi.fn()}
        taskStatus="done"
      />,
    );
    screen.getByText('Mark complete').click();
    expect(markTaskCompleteMock).toHaveBeenCalledWith('task-123');
  });

  it('does not render "Mark complete" while the task is running or chat has no task', () => {
    const { container } = render(
      <ChatListItem
        chat={makeChatItem({ taskId: 'task-123' })}
        isSelected={false}
        onClick={vi.fn()}
        onRename={vi.fn()}
        taskStatus="running"
      />,
    );
    expect(container.textContent).not.toContain('Mark complete');

    const { container: noTask } = render(
      <ChatListItem
        chat={makeChatItem()}
        isSelected={false}
        onClick={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    expect(noTask.textContent).not.toContain('Mark complete');
  });

  // Left icons = live running signal; right pill = persistent task status. A follow-up message into a
  // chat whose flow task rests on `done` ("Review") re-runs the agent: the left icons must show
  // running while the right pill keeps reading green "Review".
  describe('running signal decoupled from the resting task pill', () => {
    const runningIconClass = (svg: Element | null) => svg?.getAttribute('class') ?? '';

    it('a done task chat that is live-loading shows running on the left while the right pill stays "Review"', () => {
      const { container } = render(
        <ChatListItem
          chat={makeChatItem({ taskId: 'task-done', isLoading: true })}
          taskStatus="done"
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      // Left: task icon pulses primary + corner activity dot present (live agent run).
      const taskIcon = container.querySelector('svg.lucide-list-todo');
      expect(runningIconClass(taskIcon)).toContain('text-[hsl(var(--primary))]');
      expect(runningIconClass(taskIcon)).toContain('animate-pulse');
      expect(screen.getByRole('status', { name: 'Agent is running' })).toBeTruthy();
      // Single live region: the running corner dot is the only role=status, so a SR hears "running",
      // not a contradiction with the resting pill (the pill drops its status role while running).
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      // Right: the resting pill is UNCHANGED — green "Review".
      expect(screen.getAllByText('Review').length).toBeGreaterThan(0);
      expect(
        container.querySelector('span.bg-\\[hsl\\(var\\(--status-online\\)\\)\\]'),
      ).toBeTruthy();
    });

    it('also pulses the worktree icon while running (both left icons reflect the live state)', () => {
      const { container } = render(
        <ChatListItem
          chat={makeChatItem({ taskId: 'task-wt', isLoading: true, isWorktree: true })}
          taskStatus="done"
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      const worktreeIcon = container.querySelector('svg.lucide-git-fork');
      expect(runningIconClass(worktreeIcon)).toContain('text-[hsl(var(--primary))]');
      expect(runningIconClass(worktreeIcon)).toContain('animate-pulse');
    });

    it('an idle done task chat is unchanged: green static icon, no pulse, no activity dot', () => {
      const { container } = render(
        <ChatListItem
          chat={makeChatItem({ taskId: 'task-idle' })}
          taskStatus="done"
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      const taskIcon = container.querySelector('svg.lucide-list-todo');
      expect(runningIconClass(taskIcon)).toContain('text-[hsl(var(--status-online-text))]');
      expect(runningIconClass(taskIcon)).not.toContain('animate-pulse');
      // No corner activity dot (the dot is the role=status span carrying an aria-label; the resting
      // "Review" pill also has role=status but no aria-label, so target the dot's labels precisely).
      expect(
        container.querySelector(
          'span[role="status"][aria-label="Agent is running"], span[role="status"][aria-label="Task running"]',
        ),
      ).toBeNull();
      expect(screen.getAllByText('Review').length).toBeGreaterThan(0);
    });

    it('a plain (taskless) chat that is loading still shows the running dot + pulsing icon', () => {
      const { container } = render(
        <ChatListItem
          chat={makeChatItem({ isLoading: true })}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      expect(screen.getByRole('status', { name: 'Agent is running' })).toBeTruthy();
      const chatIcon = container.querySelector('svg.lucide-message-square');
      expect(runningIconClass(chatIcon)).toContain('text-[hsl(var(--primary))]');
      expect(runningIconClass(chatIcon)).toContain('animate-pulse');
    });
  });

  // A held AskUserQuestion keeps its task `running` in the DB for the whole hold window (nothing
  // persists until the park — docs/decisions/agent-user-question-mechanism.md), so the live
  // pendingQuestion state must outrank an ACTIVE task status. Terminal/parked statuses keep
  // winning, which lets a stale in-memory question entry self-heal once the durable status lands.
  describe('held question outranks an active task status', () => {
    it('shows the amber Waiting pill instead of Running while a question is held', () => {
      const { container } = render(
        <ChatListItem
          chat={makeChatItem({ taskId: 'task-q', hasPendingQuestion: true })}
          taskStatus="running"
          isSelected
          onClick={vi.fn()}
        />,
      );
      expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
      expect(screen.queryByText('Running')).toBeNull();
      // The busy treatment is suppressed: amber icon, no pulse, no corner activity dot.
      const taskIcon = container.querySelector('svg.lucide-list-todo');
      expect(taskIcon?.getAttribute('class') ?? '').toContain('text-warning');
      expect(taskIcon?.getAttribute('class') ?? '').not.toContain('animate-pulse');
      expect(
        container.querySelector(
          'span[role="status"][aria-label="Agent is running"], span[role="status"][aria-label="Task running"]',
        ),
      ).toBeNull();
      // With running suppressed, the Waiting pill is the single live region.
      const statusRegions = container.querySelectorAll('[role="status"]');
      expect(statusRegions).toHaveLength(1);
      expect(statusRegions[0]?.textContent).toContain('Waiting for your response');
    });

    it('also outranks a pending (queued) task', () => {
      render(
        <ChatListItem
          chat={makeChatItem({ taskId: 'task-q', hasPendingQuestion: true })}
          taskStatus="pending"
          isSelected
          onClick={vi.fn()}
        />,
      );
      expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
    });

    it('a parked needs_attention task outranks a stale question entry', () => {
      render(
        <ChatListItem
          chat={makeChatItem({ taskId: 'task-parked', hasPendingQuestion: true })}
          taskStatus="needs_attention"
          isSelected
          onClick={vi.fn()}
        />,
      );
      expect(screen.getAllByText('Attention').length).toBeGreaterThan(0);
      expect(screen.queryByText('Waiting')).toBeNull();
    });

    it('a finished done task outranks a stale question entry', () => {
      render(
        <ChatListItem
          chat={makeChatItem({ taskId: 'task-done', hasPendingQuestion: true })}
          taskStatus="done"
          isSelected
          onClick={vi.fn()}
        />,
      );
      expect(screen.getAllByText('Review').length).toBeGreaterThan(0);
      expect(screen.queryByText('Waiting')).toBeNull();
    });

    it('a plan awaiting approval still wins over a pending question on the same chat', () => {
      const { container } = render(
        <ChatListItem
          chat={makeChatItem({ taskId: 'task-plan', hasPendingQuestion: true })}
          taskStatus="plan_ready"
          isSelected
          onClick={vi.fn()}
        />,
      );
      expect(screen.getByRole('status', { name: 'Plan awaiting approval' })).toBeTruthy();
      // The Plan icon is the complete affordance — no duplicate pill dot.
      expect(container.querySelector('.h-1\\.5')).toBeNull();
    });
  });

  // The friendly-ladder: selection reveals more detail without implying that an idle chat is live.
  describe('friendly-ladder states', () => {
    it('a selected idle row gains weight + primary fill but keeps its icon stopped-gray', () => {
      const { container } = render(
        <ChatListItem chat={makeChatItem()} isSelected onClick={vi.fn()} />,
      );
      const row = container.querySelector('[role="treeitem"]');
      expect(row?.className).toContain('font-medium');
      expect(row?.className).toContain('bg-primary/15');
      const icon = container.querySelector('svg.lucide-message-square');
      expect(icon?.getAttribute('class') ?? '').not.toContain('text-[hsl(var(--primary))]');
    });

    it('a selected idle task keeps the stopped task icon color', () => {
      const { container } = render(
        <ChatListItem chat={makeChatItem({ taskId: 'task-idle' })} isSelected onClick={vi.fn()} />,
      );
      const icon = container.querySelector('svg.lucide-list-todo');
      expect(icon?.getAttribute('class') ?? '').toContain('text-muted-foreground/90');
      expect(icon?.getAttribute('class') ?? '').not.toContain('text-[hsl(var(--primary))]');
    });

    it('keeps the status as a bare dot at rest and reveals the label on selection', () => {
      // The visible status label carries `tabular-nums`; the tooltip's reason text ("Running") does not.
      const labelOf = (q: ReturnType<typeof render>) =>
        q.getAllByText('Running').find((el) => el.className.includes('tabular-nums'));

      const rest = render(
        <ChatListItem
          chat={makeChatItem({ taskId: 't' })}
          taskStatus="running"
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      const restLabel = labelOf(rest);
      expect(restLabel?.className).toContain('hidden');
      expect(restLabel?.className).toContain('group-hover:inline');
      expect(restLabel?.className).toContain('group-focus-within:inline');
      cleanup();

      const sel = render(
        <ChatListItem
          chat={makeChatItem({ taskId: 't' })}
          taskStatus="running"
          isSelected
          onClick={vi.fn()}
        />,
      );
      const selLabel = labelOf(sel);
      expect(selLabel?.className).toContain('inline');
      expect(selLabel?.className).not.toContain('hidden');
    });

    it('renders a relative-time stamp from updatedAt (revealed on engage)', () => {
      const { container } = render(
        <ChatListItem
          chat={makeChatItem({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      // formatShortTimeAgo(~2h ago) -> "2h"; the span sits in the DOM, revealed via group-hover/focus.
      expect(container.textContent).toContain('2h');
    });
  });
});
