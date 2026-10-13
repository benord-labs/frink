// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { createStore, Provider } from 'jotai';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openFilesAtom } from '@/lib/code-editor/state';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { trpc } from '@/lib/trpc';
import { buildTriggerSummary } from '../../../../../shared/lib/trigger-summary';
import type { TriggerContext } from '../../../../../shared/types/trigger-context';
import { TooltipProvider } from '../../../../components/ui/tooltip';
import { splitViewAtom } from '../../atoms';
import { CurrentChatWorktreeProvider } from '../../context/current-chat-worktree-context';
import { MemoizedTextPart } from '../../main/memoized-text-part';
import { SearchHighlightProvider } from '../../search';
import {
  chatSearchCurrentIndexAtom,
  chatSearchMatchesAtom,
  chatSearchOpenAtom,
  chatSearchQueryAtom,
} from '../../search/chat-search-atoms';
import { extractSearchableText, findMatches } from '../../search/chat-search-utils';
import { TriggerBubble } from '../../ui/trigger-bubble';
import { FileLinkBadge, FileLinkBadgeProvider } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

async function answerHomePath(op: Operation): Promise<string> {
  if (op.path !== 'external.getHomePath') throw new Error(`Unexpected test operation: ${op.path}`);
  return '/Users/sam';
}

/** The visible badge showing `name`, not the hidden text it stands in for. */
function badgeNamed(name: string, scope: Pick<typeof screen, 'getByText'> = screen): HTMLElement {
  const text = scope.getByText(name, { ignore: '[aria-hidden]' });
  const badge = text.closest<HTMLElement>('[data-search-skip]');
  if (!badge) throw new Error(`No badge around ${name}`);
  return badge;
}

describe('FileLinkBadge', () => {
  it('shows the file name and line, with the path as it was written as its tooltip', () => {
    render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: './src/./a.ts', line: 12, label: './src/./a.ts' }} />
      </TooltipProvider>,
    );

    const badge = badgeNamed('a.ts');
    expect(badge).toHaveTextContent(/^a\.tsL12$/);
    expect(badge.querySelector('svg')).not.toBeNull();
    fireEvent.focus(badge);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^src\/a\.ts$/);
  });

  it('shows a home path as written and no line when none is given', () => {
    render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: '~/notes/a.md', label: '~/notes/a.md' }} />
      </TooltipProvider>,
    );

    expect(badgeNamed('a.md')).toHaveTextContent(/^a\.md$/);
    fireEvent.focus(badgeNamed('a.md'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^~\/notes\/a\.md$/);
  });

  it("keeps a link's own words and shows the badge after them", () => {
    const { container } = render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: '/Users/x/handler.ts', label: 'the handler' }} />
      </TooltipProvider>,
    );

    expect(container.firstChild).toHaveTextContent(/^the handler$/);
    expect(badgeNamed('handler.ts').previousSibling).toBe(container.firstChild);
  });

  it('is a focusable span, not a link or a button, when the file cannot be opened', () => {
    render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: '/Users/x/a.ts', label: 'a.ts' }} />
      </TooltipProvider>,
    );

    expect(badgeNamed('a.ts')).toHaveAttribute('tabindex', '0');
    expect(badgeNamed('a.ts').tagName).toBe('SPAN');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is a button that opens the file when it can be opened', () => {
    const onOpen = vi.fn();
    render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: 'src/a.ts', label: 'src/a.ts' }} onOpen={onOpen} />
      </TooltipProvider>,
    );

    const badge = screen.getByRole('button', { name: 'a.ts' });
    expect(badge).toBe(badgeNamed('a.ts'));
    expect(badge).toHaveAttribute('type', 'button');
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  // In Chromium a selection across the badge then reads `Fixed src/a.ts:12 and`, on one line: it
  // ends a copied line on leaving a box, unless the last thing inside that box has no box itself.
  it('leaves the written text to a selection, and the badge and its parts out of it', () => {
    render(
      <TooltipProvider>
        <FileLinkBadge reference={{ path: 'src/a.ts', line: 12, label: 'src/a.ts:12' }} />
      </TooltipProvider>,
    );

    const badge = badgeNamed('a.ts');
    expect(screen.getByText('src/a.ts:12')).not.toHaveClass('select-none');
    expect(badge).toHaveClass('select-none');
    for (const part of ['a.ts', 'L12']) {
      const text = within(badge).getByText(part);
      const box = text.parentElement;
      expect(text).toHaveClass('contents');
      expect(box?.lastChild).toBe(text);
      expect(box?.parentElement).toBe(badge);
    }
  });
});

type Entry = { path: string; type: 'file' | 'folder' };

type Project = {
  /** What the folder the chat works in holds right now. */
  disk: Entry[];
  /** What the project file search lists, which can lag behind or leave out what is on disk. */
  index?: Entry[];
  /** The chat's own worktree; a chat without one works in its project's folder. */
  worktreePath?: string | null;
  /** The folder of the chat's project; null for a chat that has no project. */
  projectPath?: string | null;
  /** The chats side by side in split view, in pane order; none in single view. */
  panes?: string[];
};

const ROOT = '/Users/sam/app';

const lookup = z.object({ relativePath: z.string() });

/** A reply in chat `chat-1`, which works in `ROOT`; `asked` lists all but the home folder lookup, in order. */
function renderReply(
  text: string,
  { disk, index = disk, worktreePath = null, projectPath = ROOT, panes = [] }: Project,
) {
  const store = createStore();
  store.set(splitViewAtom, {
    chatIds: panes,
    ratios: [],
    activePaneIndex: 0,
    layout: 'horizontal',
  });
  // The app keeps a query's answer for five seconds unless a query says otherwise.
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5000 } },
  });
  // The chat view loaded the chat long before this reply, and is the one that keeps it fresh.
  queries.setQueryData(
    getQueryKey(trpc.chats.get, { id: 'chat-1' }, 'query'),
    { project: projectPath ? { path: projectPath } : null },
    { updatedAt: 0 },
  );
  const asked: [path: string, input: unknown][] = [];
  renderWithTrpc<string | Entry[] | Entry['type'] | null>(
    <Provider store={store}>
      <TooltipProvider>
        <CurrentChatWorktreeProvider worktreePath={worktreePath} chatId="chat-1">
          <FileLinkBadgeProvider>
            <MemoizedTextPart
              text={text}
              messageId="m1"
              partIndex={0}
              isFinalText
              visibleStepsCount={1}
              renderMarkdown
            />
          </FileLinkBadgeProvider>
        </CurrentChatWorktreeProvider>
      </TooltipProvider>
    </Provider>,
    async (op) => {
      if (op.path === 'external.getHomePath') return answerHomePath(op);
      asked.push([op.path, op.input]);
      if (op.path === 'files.search') return index;
      const { relativePath } = lookup.parse(op.input);
      return disk.find((entry) => entry.path === relativePath)?.type ?? null;
    },
    queries,
  );
  return { store, asked };
}

const typeOf = (relativePath: string) => ['files.entryType', { projectPath: ROOT, relativePath }];
const searchFor = (query: string) => ['files.search', { projectPath: ROOT, query }];

describe('opening a file from its badge', () => {
  const reveals: unknown[] = [];
  const recordReveal = (event: Event) => {
    if (event instanceof CustomEvent) reveals.push(event.detail);
  };
  let toasts = 0;
  beforeEach(() => {
    reveals.length = 0;
    toasts = toast.getHistory().length;
    window.addEventListener('editor:reveal-line', recordReveal);
  });
  afterEach(() => window.removeEventListener('editor:reveal-line', recordReveal));

  it('opens the file at the written path, in the project of a chat that runs in it, at its line', async () => {
    const { store, asked } = renderReply('Fixed `src/a.ts:12`.', {
      disk: [
        { path: 'src/a.ts', type: 'file' },
        { path: 'packages/web/src/a.ts', type: 'file' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }));

    await waitFor(() =>
      expect(reveals).toEqual([
        {
          filePath: '/Users/sam/app/src/a.ts',
          lineNumber: 12,
          startColumn: undefined,
          endColumn: undefined,
        },
      ]),
    );
    expect(store.get(openFilesAtom)).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        name: 'a.ts',
        projectPath: '/Users/sam/app',
        isWorktreeContext: false,
        sourceChatId: 'chat-1',
        isPreview: false,
      }),
    ]);
    expect(store.get(openFilesAtom)[0]?.sourcePaneIndex).toBeUndefined();
    expect(asked).toEqual([typeOf('src/a.ts')]);
  });

  // The project file search stops at a ceiling and skips build output, logs, lock files and links.
  it.each([
    ['build/entitlements.mac.plist', 'build/entitlements.mac.plist'],
    ['./bun.lock', 'bun.lock'],
    ['/Users/sam/app/src/main/index.ts', 'src/main/index.ts'],
    ['~/app/logs/app.log', 'logs/app.log'],
  ])('opens %s, a file the project file search does not list', async (file, relativePath) => {
    const { store, asked } = renderReply(`See \`${file}\`.`, {
      disk: [{ path: relativePath, type: 'file' }],
      index: [],
    });
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);

    fireEvent.click(await screen.findByRole('button', { name }));

    await waitFor(() => expect(store.get(openFilesAtom)).toHaveLength(1));
    expect(store.get(openFilesAtom)[0]).toMatchObject({ path: relativePath, projectPath: ROOT });
    expect(asked).toEqual([typeOf(relativePath)]);
    expect(toast.getHistory()).toHaveLength(toasts);
  });

  it('opens the one file a shortened path ends, in the worktree of a chat that has one', async () => {
    const { store, asked } = renderReply('See `admission/store.ts`.', {
      disk: [
        { path: 'src/main/lib/flows/admission/store.ts', type: 'file' },
        { path: 'src/main/lib/flows/readmission/store.ts', type: 'file' },
      ],
      worktreePath: ROOT,
      projectPath: '/Users/sam/main-checkout',
    });

    fireEvent.click(screen.getByRole('button', { name: 'store.ts' }));

    await waitFor(() =>
      expect(store.get(openFilesAtom)).toEqual([
        expect.objectContaining({
          path: 'src/main/lib/flows/admission/store.ts',
          name: 'store.ts',
          projectPath: '/Users/sam/app',
          isWorktreeContext: true,
        }),
      ]),
    );
    expect(reveals).toEqual([]);
    expect(asked).toEqual([
      typeOf('admission/store.ts'),
      searchFor('admission/store.ts'),
      typeOf('src/main/lib/flows/admission/store.ts'),
    ]);
  });

  it('opens the tab in the split-view pane the chat sits in', async () => {
    const { store } = renderReply('See `src/a.ts`.', {
      disk: [{ path: 'src/a.ts', type: 'file' }],
      panes: ['chat-0', 'chat-1'],
    });

    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));

    await waitFor(() => expect(store.get(openFilesAtom)).toHaveLength(1));
    expect(store.get(openFilesAtom)[0]).toMatchObject({ path: 'src/a.ts', sourcePaneIndex: 1 });
  });

  it.each([
    ['at the written path', './src/lib', 'lib', [typeOf('src/lib')]],
    [
      'that a shortened path ends',
      'ios/App.xcodeproj',
      'App.xcodeproj',
      [
        typeOf('ios/App.xcodeproj'),
        searchFor('ios/App.xcodeproj'),
        typeOf('apps/mobile/ios/App.xcodeproj'),
      ],
    ],
  ])('opens no tab, and says nothing, for a folder %s', async (_, folder, name, lookups) => {
    const { store, asked } = renderReply(`In \`${folder}\` and \`src/a.ts\`.`, {
      disk: [
        { path: 'src/lib', type: 'folder' },
        { path: 'apps/mobile/ios/App.xcodeproj', type: 'folder' },
        { path: 'src/a.ts', type: 'file' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(asked).toEqual(lookups));
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));

    // The folder's click has run its course by now, so it would have opened its tab or said so.
    await waitFor(() => expect(store.get(openFilesAtom)).toHaveLength(1));
    expect(store.get(openFilesAtom)[0]?.path).toBe('src/a.ts');
    expect(toast.getHistory()).toHaveLength(toasts);
  });

  it.each<[string, string, Project]>([
    ['no file', 'src/gone.ts', { disk: [] }],
    [
      'several files',
      'lib/store.ts',
      {
        disk: [
          { path: 'src/main/lib/store.ts', type: 'file' },
          { path: 'src/renderer/lib/store.ts', type: 'file' },
        ],
      },
    ],
    [
      'only a file deleted since the search last listed it',
      'lib/gone.ts',
      { disk: [], index: [{ path: 'src/lib/gone.ts', type: 'file' }] },
    ],
  ])(
    'says the file was not found, and opens nothing, when %s matches',
    async (_, file, project) => {
      const { store } = renderReply(`See \`${file}\`.`, project);
      const name = file.slice(file.lastIndexOf('/') + 1);

      fireEvent.click(screen.getByRole('button', { name }));

      await waitFor(() => expect(toast.getHistory()).toHaveLength(toasts + 1));
      expect(toast.getHistory().at(-1)).toMatchObject({
        type: 'error',
        title: `Couldn't find ${name} in this project`,
      });
      expect(store.get(openFilesAtom)).toEqual([]);
    },
  );

  it.each(['/Users/sam/app/src/gone.ts', '~/app/src/gone.ts', './src/gone.ts'])(
    'does not take %s, a full path to a missing file, for a shortened one',
    async (file) => {
      const { store, asked } = renderReply(`See \`${file}\`.`, {
        disk: [{ path: 'packages/web/src/gone.ts', type: 'file' }],
      });

      fireEvent.click(await screen.findByRole('button', { name: 'gone.ts' }));

      await waitFor(() => expect(toast.getHistory()).toHaveLength(toasts + 1));
      expect(store.get(openFilesAtom)).toEqual([]);
      expect(asked).toEqual([typeOf('src/gone.ts')]);
    },
  );

  it('reads the project afresh on every click', async () => {
    const disk: Entry[] = [];
    const { store, asked } = renderReply('See `src/a.ts`.', { disk });
    const badge = screen.getByRole('button', { name: 'a.ts' });

    fireEvent.click(badge);
    await waitFor(() => expect(toast.getHistory()).toHaveLength(toasts + 1));

    disk.push({ path: 'src/a.ts', type: 'file' });
    fireEvent.click(badge);
    await waitFor(() => expect(store.get(openFilesAtom)).toHaveLength(1));

    disk.length = 0;
    store.set(openFilesAtom, []);
    fireEvent.click(badge);
    await waitFor(() => expect(toast.getHistory()).toHaveLength(toasts + 2));
    expect(store.get(openFilesAtom)).toEqual([]);
    expect(asked.filter(([path]) => path === 'files.entryType')).toHaveLength(3);
  });

  it('leaves a file outside the folder the chat works in as a badge that only shows', async () => {
    renderReply('See `~/notes/a.md` and `~/app/src/b.ts`.', { disk: [] });

    expect(await screen.findByRole('button', { name: 'b.ts' })).toBe(badgeNamed('b.ts'));
    expect(badgeNamed('a.md').tagName).toBe('SPAN');
  });

  it.each([
    ['no project', null],
    ['a project that only groups chats', 'virtual://folders/1'],
  ])('leaves every badge as one that only shows in a chat with %s', (_, projectPath) => {
    renderReply('See `src/a.ts`.', { disk: [{ path: 'src/a.ts', type: 'file' }], projectPath });

    expect(badgeNamed('a.ts').tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('file badges in a chat transcript', () => {
  const reply = 'Fixed `src/a.ts:42` and [notes](~/notes/a.md).';
  const trigger: TriggerContext = {
    source: 'shortcut',
    sourceAccountId: 'acc',
    eventType: 'story_update',
    triggeredBy: { name: 'Tester' },
    timestamp: '2026-03-03T10:00:00.000Z',
    fullContent: { actions: [{ entity_type: 'story', name: 'Fix it', description: reply }] },
  };

  it('draws badges in an assistant reply but not in a trigger dialog opened beside it', () => {
    renderWithTrpc(
      <TooltipProvider>
        <FileLinkBadgeProvider>
          <section aria-label="Transcript">
            <MemoizedTextPart
              text={reply}
              messageId="m1"
              partIndex={0}
              isFinalText
              visibleStepsCount={1}
              renderMarkdown
            />
          </section>
          <TriggerBubble data={buildTriggerSummary(trigger)} triggerContext={trigger} />
        </FileLinkBadgeProvider>
      </TooltipProvider>,
      answerHomePath,
    );

    const transcript = within(screen.getByRole('region', { name: 'Transcript' }));
    const tooltip = () => screen.getByRole('tooltip');
    expect(badgeNamed('a.ts', transcript)).toHaveTextContent(/^a\.tsL42$/);
    fireEvent.focus(badgeNamed('a.ts', transcript));
    expect(tooltip()).toHaveTextContent(/^src\/a\.ts$/);
    fireEvent.blur(badgeNamed('a.ts', transcript));
    fireEvent.focus(badgeNamed('a.md', transcript));
    expect(tooltip()).toHaveTextContent(/^~\/notes\/a\.md$/);
    expect(transcript.getByText(/and notes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Open content' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('src/a.ts:42')).not.toHaveAttribute('aria-hidden');
    expect(dialog.queryByText('a.ts')).toBeNull();
    expect(dialog.queryByText('a.md')).toBeNull();
  });

  // Chat search counts matches in the reply's text, then highlights the page by match position.
  it.each(['renderer', 'x.tsx', 'components/x.tsx:42', '42'])(
    'keeps chat search for %j in step with the badges',
    (query) => {
      const text =
        'Changed `src/renderer/components/x.tsx:42` and `src/renderer/y.ts`; the renderer and x.tsx are fine at 42.';
      const matches = findMatches(
        extractSearchableText([{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text }] }]),
        query,
      );
      expect(matches.length).toBeGreaterThan(0);

      matches.forEach((_match, current) => {
        const store = createStore();
        store.set(chatSearchOpenAtom, true);
        store.set(chatSearchQueryAtom, query);
        store.set(chatSearchMatchesAtom, matches);
        store.set(chatSearchCurrentIndexAtom, current);
        const { container, unmount } = renderWithTrpc(
          <Provider store={store}>
            <TooltipProvider>
              <SearchHighlightProvider>
                <FileLinkBadgeProvider>
                  <MemoizedTextPart
                    text={text}
                    messageId="m1"
                    partIndex={0}
                    isFinalText
                    visibleStepsCount={0}
                    renderMarkdown
                  />
                </FileLinkBadgeProvider>
              </SearchHighlightProvider>
            </TooltipProvider>
          </Provider>,
          answerHomePath,
        );

        const marks = Array.from(container.querySelectorAll('mark'));
        expect(marks).toHaveLength(matches.length);
        expect(marks.findIndex((mark) => mark.matches('.search-highlight-current'))).toBe(current);
        unmount();
      });
    },
  );
});
