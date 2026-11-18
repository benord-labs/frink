// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Operation } from '@trpc/client';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { newTestQueryClient, renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { LinkedProjectChips } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const readLoadedChatTexts = vi.hoisted(() => vi.fn((_chatId: string): string[] => []));
vi.mock('../../../../stores/message-store', () => ({ readLoadedChatTexts }));

const app = { id: 'app', name: 'app', path: '/w/app' };
const PROJECTS = [
  app,
  ...['api', 'web', 'docs', 'ui'].map((id) => ({ id, name: id, path: `/w/${id}` })),
];
const chat = (project: object | null) => ({ worktreePath: null, branch: null, project });
const CHATS: Record<string, object> = {
  'app-chat': chat(app),
  general: chat(null),
  virtual: chat({ id: 'ideas', name: 'Ideas', path: 'virtual://ideas' }),
};
const RUNNING_HINT =
  'The agent can read it from its next step and hears about it with your next message.';
/** The class that shows a label once the row is wide enough */
const LABEL_SHOWN = '@min-[30rem]/workspace-row:inline';

/** The project ids linked to app-chat, in link order; `missing` ones are gone from disk */
let links: string[] = [];
let missing: string[] = [];
let refuseUnlink = false;

async function answer(op: Operation): Promise<unknown> {
  const { id = '', projectId = '' } = (op.input ?? {}) as Record<string, string>;
  if (op.path === 'chats.get') {
    const linkedProjects = (id === 'app-chat' ? links : []).map((each) => ({
      ...PROJECTS.find((project) => project.id === each),
      missing: missing.includes(each),
    }));
    return { ...CHATS[id], linkedProjects };
  }
  if (op.path === 'chats.linkProject') {
    links = [...links, projectId];
    return { success: true };
  }
  if (op.path === 'chats.unlinkProject') {
    if (refuseUnlink) throw new Error('database closed');
    links = links.filter((each) => each !== projectId);
    return { success: true };
  }
  if (op.path === 'changes.getBranches') return { current: 'main' };
  if (op.path === 'projects.list') return PROJECTS;
  if (op.path === 'chats.linkableProjects') {
    return PROJECTS.filter((project) => project !== app).map((project) => project.id);
  }
  throw new Error(`Unexpected test operation: ${op.path}`);
}

function renderChips(chatIds = ['app-chat'], running = false, queryClient = newTestQueryClient()) {
  renderWithTrpc(
    <TooltipProvider>
      {chatIds.map((chatId) => (
        <LinkedProjectChips key={chatId} chatId={chatId} running={running} />
      ))}
    </TooltipProvider>,
    answer,
    queryClient,
  );
  return userEvent.setup();
}

/** Each control in the group, and the whole of each name, is this wide in `stubLayout`. */
const CONTROL_PX = 60;
const NAME_PX = 80;
type Layout = { row: number; group: number; name: number };

/**
 * Lays the chips out, as happy-dom can't: the group is `group` wide in a row `row` wide, and each
 * name shows `name` of itself. `resize` reports a new layout as a browser's ResizeObserver does.
 */
function stubLayout(initial: Layout) {
  const layout = { ...initial };
  const observers = new Set<FakeResizeObserver>();
  class FakeResizeObserver {
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      observers.delete(this);
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const width = (element: HTMLElement, whole: boolean) => {
    if (element.getAttribute('role') === 'group') {
      const shown = Array.from(element.children).filter(
        (child) => !child.classList.contains('hidden'),
      );
      return whole ? shown.length * CONTROL_PX : layout.group;
    }
    if (element.hasAttribute('data-chip-name')) return whole ? NAME_PX : layout.name;
    const isRow = Array.from(element.children).some(
      (child) => child.getAttribute('role') === 'group',
    );
    return isRow ? layout.row : 0;
  };
  const names = ['clientWidth', 'scrollWidth'] as const;
  const originals = names.map((name) =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
  );
  names.forEach((name) =>
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return width(this, name === 'scrollWidth');
      },
    }),
  );
  restoreLayout = () => {
    names.forEach((name, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(HTMLElement.prototype, name, original);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
    vi.unstubAllGlobals();
  };
  return {
    resize(next: Layout) {
      Object.assign(layout, next);
      act(() => {
        for (const observer of observers)
          observer.callback([], observer as unknown as ResizeObserver);
      });
    },
  };
}
let restoreLayout = () => {};

const chipsGroup = () => screen.findByRole('group', { name: 'Linked projects' });
const buttonNames = (element: HTMLElement) =>
  within(element)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'));
/** Each paragraph of the open tooltip, or its text when it has none */
function tooltipLines() {
  const tooltip = screen.getByRole('tooltip');
  const lines = Array.from(tooltip.children, (line) => line.textContent);
  return lines.length > 0 ? lines : [tooltip.textContent];
}

afterEach(() => {
  cleanup();
  restoreLayout();
  restoreLayout = () => {};
  links = [];
  missing = [];
  refuseUnlink = false;
  readLoadedChatTexts.mockReset().mockReturnValue([]);
});

describe('LinkedProjectChips', () => {
  it('shows only Link project for a chat with no links, on one line', async () => {
    renderChips();

    const group = await chipsGroup();
    expect(buttonNames(group)).toEqual(['Link project']);
    expect(group).toHaveClass('min-w-0');
    expect(group).not.toHaveClass('flex-wrap');
  });

  // Without a floor of its own, a chip stays as wide as its whole name and runs past the group.
  it('lets each chip shrink to its icons and x, so a long name truncates', async () => {
    links = ['api', 'web'];
    missing = ['web'];
    renderChips();

    const chip = async (name: string) =>
      (await screen.findByRole('button', { name: `Unlink ${name}` })).parentElement;
    expect(await chip('api')).toHaveClass('min-w-12', 'max-w-[10rem]');
    expect(await chip('web')).toHaveClass('min-w-16', 'max-w-[10rem]');
    expect(screen.getByText('api')).toHaveClass('truncate');
  });

  it('shows two links as chips and lists the rest behind a count, each with its own x', async () => {
    links = ['api', 'web', 'docs'];
    const user = renderChips();

    const group = await chipsGroup();
    await within(group).findByRole('button', { name: 'Unlink web' });
    expect(buttonNames(group)).toEqual(['Unlink api', 'Unlink web', '+1 linked', 'Link project']);
    await user.click(within(group).getByRole('button', { name: '+1 linked' }));
    const more = await screen.findByRole('list', { name: 'More linked projects' });
    const row = within(more).getByRole('listitem');
    expect(row).toHaveAttribute('title', 'docs is linked to this chat.\n/w/docs');
    expect(within(row).getByText('/w/docs')).toBeVisible();
    await user.click(within(more).getByRole('button', { name: 'Unlink docs' }));

    await waitFor(() => expect(buttonNames(group)).not.toContain('+1 linked'));
    expect(links).toEqual(['api', 'web']);
  });

  it('keeps the list open after unlinking one of several links in it, with focus on the next', async () => {
    links = ['api', 'web', 'docs', 'ui'];
    const user = renderChips();

    await user.click(await screen.findByRole('button', { name: '+2 linked' }));
    const more = await screen.findByRole('list', { name: 'More linked projects' });
    await user.click(within(more).getByRole('button', { name: 'Unlink docs' }));

    await waitFor(() => expect(links).toEqual(['api', 'web', 'ui']));
    await waitFor(() => expect(within(more).queryByText('docs')).toBeNull());
    expect(within(more).getByRole('button', { name: 'Unlink ui' })).toHaveFocus();
    expect(screen.getByRole('list', { name: 'More linked projects' })).toBe(more);
  });

  it('warns on the count, and in its list, when a link behind it has lost its folder', async () => {
    links = ['api', 'web', 'docs'];
    missing = ['docs'];
    const user = renderChips(['app-chat'], true);

    await user.click(await screen.findByRole('button', { name: '+1 linked, folder missing' }));
    const more = await screen.findByRole('list', { name: 'More linked projects' });

    const row = within(more).getByRole('listitem');
    expect(within(row).getByText("Can't find docs's folder.")).toBeVisible();
    expect(row).toHaveAttribute('title', "Can't find docs's folder.\n/w/docs");
    expect(within(row).getByRole('button', { name: 'Unlink docs' })).toHaveAccessibleDescription(
      "Can't find docs's folder. /w/docs",
    );
  });

  // While the chat runs its workspace is locked, which holds back only folder and branch changes.
  it('unlinks with the x while the chat runs, then moves focus to Link project once the chip is gone', async () => {
    links = ['api', 'web'];
    const user = renderChips(['app-chat'], true);

    await user.click(await screen.findByRole('button', { name: 'Unlink api' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unlink api' })).toBeNull());
    expect(links).toEqual(['web']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Link project' })).toHaveFocus());
  });

  it("keeps the chip and its focus, and shows the server's message, when unlinking fails", async () => {
    links = ['api'];
    refuseUnlink = true;
    const toasts = toast.getHistory().length;
    const queryClient = newTestQueryClient();
    const user = renderChips(['app-chat'], false, queryClient);

    const unlink = await screen.findByRole('button', { name: 'Unlink api' });
    await user.click(unlink);

    await waitFor(() => expect(toast.getHistory()).toHaveLength(toasts + 1));
    expect(toast.getHistory().at(-1)).toMatchObject({ type: 'error', title: 'database closed' });
    expect(unlink).toBeInTheDocument();
    expect(unlink).toHaveFocus();

    // A link made later, say from another window, leaves focus where it is.
    act(() => unlink.blur());
    links = ['api', 'web'];
    await act(() => queryClient.invalidateQueries());
    await screen.findByRole('button', { name: 'Unlink web' });
    expect(document.body).toHaveFocus();
  });

  it('links the project picked from Link project, listing those the chat mentions first', async () => {
    readLoadedChatTexts.mockReturnValue(['Fixed /w/web/src/x.ts']);
    const user = renderChips();

    await user.click(await screen.findByRole('button', { name: 'Link project' }));
    const rows = await screen.findAllByRole('menuitem');
    expect(rows.map((row) => row.getAttribute('title'))).toEqual([
      '/w/web',
      '/w/api',
      '/w/docs',
      '/w/ui',
    ]);
    expect(rows[0]).toHaveTextContent('Mentioned in this chat');
    expect(readLoadedChatTexts).toHaveBeenCalledWith('app-chat');
    await user.click(rows[0]);

    await screen.findByRole('button', { name: 'Unlink web' });
    expect(links).toEqual(['web']);
  });

  it.each(['general', 'virtual'])('shows nothing for a %s chat', async (chatId) => {
    // Both chats load together, so this one has loaded once the project chat shows.
    renderChips([chatId, 'app-chat']);
    await chipsGroup();

    expect(screen.getAllByRole('group', { name: 'Linked projects' })).toHaveLength(1);
  });

  it.each([
    ['Unlink api', false, [], ['api is linked to this chat.', '/w/api']],
    ['Unlink api', true, [], ['api is linked to this chat.', RUNNING_HINT, '/w/api']],
    ['Unlink api', false, ['api'], ["Can't find api's folder.", '/w/api']],
    // There is no folder for the agent to read.
    ['Unlink api', true, ['api'], ["Can't find api's folder.", '/w/api']],
    ['Link project', false, [], ['Link another project to this chat']],
    ['Link project', true, [], ['Link another project to this chat', RUNNING_HINT]],
  ])(
    'explains the chip of %s in its tooltip (running: %s, missing: %j)',
    async (button, running, gone, lines) => {
      links = ['api'];
      missing = gone;
      renderChips(['app-chat'], running);

      fireEvent.focus(await screen.findByRole('button', { name: button }));

      expect(tooltipLines()).toEqual(lines);
      expect(screen.queryByText('folder missing') !== null).toBe(gone.length > 0);
    },
  );

  // The tooltip belongs to the chip, but keyboard focus lands on its x.
  it.each([
    [false, [], 'api is linked to this chat. /w/api'],
    [true, [], `api is linked to this chat. ${RUNNING_HINT} /w/api`],
    [true, ['api'], "Can't find api's folder. /w/api"],
  ])(
    "reads the chip's tooltip out with its x (running: %s, missing: %j)",
    async (running, gone, description) => {
      links = ['api'];
      missing = gone;
      renderChips(['app-chat'], running);

      expect(await screen.findByRole('button', { name: 'Unlink api' })).toHaveAccessibleDescription(
        description,
      );
    },
  );

  describe('in a narrow row', () => {
    it('drops the labels, then chips into the count, while the chips run past the group', async () => {
      links = ['api', 'web', 'docs'];
      const layout = stubLayout({ row: 700, group: 260, name: NAME_PX });
      renderChips();
      const group = await chipsGroup();

      await within(group).findByRole('button', { name: 'Unlink web' });
      expect(within(group).getByText('Link project')).toHaveClass(LABEL_SHOWN);

      // Four controls take 240px: past 200 even without their labels, so a chip goes.
      layout.resize({ row: 300, group: 200, name: NAME_PX });
      expect(buttonNames(group)).toEqual(['Unlink api', '+2 linked', 'Link project']);
      expect(within(group).getByText('Link project')).not.toHaveClass(LABEL_SHOWN);

      // The cache timer showing up squeezes the group without resizing the row.
      layout.resize({ row: 300, group: 130, name: NAME_PX });
      expect(buttonNames(group)).toEqual(['+3 linked', 'Link project']);
      expect(within(group).getByRole('button', { name: 'Link project' })).not.toHaveClass('hidden');

      // Link project goes last; the file tree has one too.
      layout.resize({ row: 300, group: 40, name: NAME_PX });
      expect(within(group).getByRole('button', { name: 'Link project' })).toHaveClass('hidden');
      expect(within(group).getByRole('button', { name: '+3 linked' })).not.toHaveClass('hidden');

      layout.resize({ row: 700, group: 260, name: NAME_PX });
      expect(buttonNames(group)).toEqual(['Unlink api', 'Unlink web', '+1 linked', 'Link project']);
      expect(within(group).getByText('Link project')).toHaveClass(LABEL_SHOWN);
    });

    // Unlinking frees room for the chips, which must not take the open list's place mid-use.
    it('keeps the list open after an unlink from it, with focus on the row in its place', async () => {
      links = ['api', 'web', 'docs'];
      stubLayout({ row: 300, group: 170, name: NAME_PX });
      const user = renderChips();
      const group = await chipsGroup();

      await user.click(await within(group).findByRole('button', { name: '+3 linked' }));
      const more = await screen.findByRole('list', { name: 'More linked projects' });
      await user.click(within(more).getByRole('button', { name: 'Unlink web' }));

      await waitFor(() => expect(within(more).queryByText('web')).toBeNull());
      expect(screen.getByRole('list', { name: 'More linked projects' })).toBe(more);
      expect(within(more).getByRole('button', { name: 'Unlink docs' })).toHaveFocus();
      expect(buttonNames(group)).toEqual(['+2 linked', 'Link project']);

      // Closing it leaves the count in place, so focus goes back to it rather than to the page.
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('list')).toBeNull());
      await waitFor(() =>
        expect(within(group).getByRole('button', { name: '+2 linked' })).toHaveFocus(),
      );
      expect(buttonNames(group)).toEqual(['+2 linked', 'Link project']);
    });

    // A fit kept from a narrower row must not come back as the list opens.
    it('opens the list with the chips and count on show, after the row widens', async () => {
      links = ['api', 'web', 'docs', 'ui'];
      const layout = stubLayout({ row: 300, group: 200, name: NAME_PX });
      const user = renderChips();
      const group = await chipsGroup();
      await within(group).findByRole('button', { name: '+3 linked' });

      layout.resize({ row: 700, group: 260, name: NAME_PX });
      const shown = ['Unlink api', 'Unlink web', '+2 linked', 'Link project'];
      expect(buttonNames(group)).toEqual(shown);
      await user.click(within(group).getByRole('button', { name: '+2 linked' }));

      const more = await screen.findByRole('list', { name: 'More linked projects' });
      expect(within(more).getAllByRole('listitem')).toHaveLength(2);
      expect(buttonNames(group)).toEqual(shown);
      expect(within(group).getByText('Link project')).toHaveClass(LABEL_SHOWN);
    });

    it('drops a chip sooner than cut its name to a letter or two', async () => {
      links = ['api', 'web'];
      const layout = stubLayout({ row: 700, group: 400, name: 20 });
      renderChips();
      const group = await chipsGroup();

      await within(group).findByRole('button', { name: '+2 linked' });
      expect(buttonNames(group)).toEqual(['+2 linked', 'Link project']);

      layout.resize({ row: 800, group: 400, name: 50 });
      expect(buttonNames(group)).toEqual(['Unlink api', 'Unlink web', 'Link project']);
    });

    it('steps down for the git controls after it before they hide, and starts again when they change', async () => {
      links = ['api'];
      stubLayout({ row: 700, group: 400, name: NAME_PX });
      // The worktree and branch fit beside the group once it shows no chip, then beside a chip too
      let gitShrank = false;
      const crowded = () =>
        !gitShrank && screen.queryByRole('button', { name: 'Unlink api' }) !== null;
      const chips = (crowdKey: string) => (
        <TooltipProvider>
          <LinkedProjectChips chatId="app-chat" crowded={crowded} crowdKey={crowdKey} />
        </TooltipProvider>
      );
      const { rerender } = renderWithTrpc(chips('long-branch'), answer);
      const group = await chipsGroup();

      await within(group).findByRole('button', { name: '+1 linked' });
      expect(buttonNames(group)).toEqual(['+1 linked', 'Link project']);
      expect(within(group).getByRole('button', { name: 'Link project' })).not.toHaveClass('hidden');
      expect(within(group).getByText('Link project')).not.toHaveClass(LABEL_SHOWN);

      gitShrank = true;
      rerender(chips('short-branch'));
      expect(buttonNames(group)).toEqual(['Unlink api', 'Link project']);
      expect(within(group).getByText('Link project')).toHaveClass(LABEL_SHOWN);
    });
  });
});
