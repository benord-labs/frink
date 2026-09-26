// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { inferRouterOutputs } from '@trpc/server';
import { createStore, Provider } from 'jotai';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRouter } from '../../../../main/lib/trpc/routers';
import { selectedProjectAtom } from '../atoms';
import { ProjectSelector } from '.';

/** Row shape from `trpc.projects.list` — used to type mock project list data. */
type ProjectRow = inferRouterOutputs<AppRouter>['projects']['list'][number];

type ListQueryOptions = { refetchOnMount?: boolean | 'always' };

type TrpcCtx = {
  allProjects: ProjectRow[] | null | undefined;
  isLoadingAll: boolean;
  listOptions?: ListQueryOptions;
};

const trpcCtx = vi.hoisted((): TrpcCtx => ({ allProjects: null, isLoadingAll: false }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      projects: {
        list: { invalidate: vi.fn() },
      },
    }),
    projects: {
      list: {
        useQuery: (_input: undefined, options?: ListQueryOptions) => {
          trpcCtx.listOptions = options;
          return {
            get data() {
              return trpcCtx.allProjects;
            },
            get isLoading() {
              return trpcCtx.isLoadingAll;
            },
          };
        },
      },
      openFolder: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: vi.fn().mockResolvedValue(undefined),
          isPending: false,
        }),
      },
      cloneFromGitHub: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: vi.fn().mockResolvedValue(undefined),
          isPending: false,
        }),
      },
    },
    machines: {
      list: { useQuery: () => ({ data: [] }) },
    },
  },
}));

function renderWithStore(ui: ReactElement, store: ReturnType<typeof createStore>) {
  return render(<Provider store={store}>{ui}</Provider>);
}

afterEach(() => {
  cleanup();
  trpcCtx.allProjects = null;
  trpcCtx.isLoadingAll = false;
});

describe('ProjectSelector displayNameFallback', () => {
  beforeEach(() => {
    trpcCtx.allProjects = [];
    trpcCtx.isLoadingAll = false;
  });

  it('shows displayNameFallback when selection is not in list yet (new-chat race)', () => {
    const store = createStore();
    store.set(selectedProjectAtom, {
      id: 'not-in-list-yet',
      name: 'StaleAtomName',
      path: '/tmp/x',
    });

    renderWithStore(<ProjectSelector displayNameFallback="ValidatedPaneName" />, store);

    expect(screen.getByRole('button', { name: /ValidatedPaneName/i })).toBeInTheDocument();
    expect(screen.queryByText('Select repo')).not.toBeInTheDocument();
    expect(screen.queryByText('Add repository')).not.toBeInTheDocument();
  });

  it('prefers validated list name over displayNameFallback when both exist', () => {
    trpcCtx.allProjects = [
      {
        id: 'p1',
        name: 'FromList',
        description: null,
        path: '/tmp/from-list',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        gitRemoteUrl: null,
        gitProvider: null,
        gitOwner: null,
        gitRepo: null,
        isCrossMachine: false,
        lastActiveAt: null,
      } satisfies ProjectRow,
    ];

    const store = createStore();
    store.set(selectedProjectAtom, {
      id: 'p1',
      name: 'FromList',
      path: '/tmp/from-list',
    });

    renderWithStore(<ProjectSelector displayNameFallback="ParentOverride" />, store);

    expect(screen.getByRole('button', { name: /FromList/i })).toBeInTheDocument();
    expect(screen.queryByText('ParentOverride')).not.toBeInTheDocument();
  });

  it('shows the default "Select project" label when no selection, empty list, and no fallback', () => {
    const store = createStore();
    store.set(selectedProjectAtom, null);

    // Non-new-chat context (no onNewChatTargetChange) with no selection → neutral trigger label.
    renderWithStore(<ProjectSelector />, store);

    expect(screen.getByRole('button', { name: /Select project/i })).toBeInTheDocument();
  });

  it('shows the fallback label (not the default) when list is empty but displayNameFallback is set', () => {
    const store = createStore();
    store.set(selectedProjectAtom, null);

    renderWithStore(<ProjectSelector displayNameFallback="OrphanLabel" />, store);

    expect(screen.queryByText('Select project')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OrphanLabel/i })).toBeInTheDocument();
  });

  it('uses displayNameFallbackGit for GitHub avatar when selection has no git metadata', () => {
    const store = createStore();
    store.set(selectedProjectAtom, null);

    renderWithStore(
      <ProjectSelector
        displayNameFallback="PaneLabel"
        displayNameFallbackGit={{
          gitOwner: 'octocat',
          gitProvider: 'github',
        }}
      />,
      store,
    );

    const avatar = screen.getByRole('img', { name: 'octocat' });
    expect(avatar).toHaveAttribute(
      'src',
      expect.stringContaining('https://github.com/octocat.png'),
    );
  });
});

describe('ProjectSelector Add project view', () => {
  beforeEach(() => {
    trpcCtx.allProjects = [];
  });

  it('goes back to the list on Escape and reopens on the list', async () => {
    const store = createStore();
    store.set(selectedProjectAtom, null);
    renderWithStore(
      <ProjectSelector newChatTarget="unset" onNewChatTargetChange={vi.fn()} />,
      store,
    );

    fireEvent.click(screen.getByRole('button', { name: /Open project/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Add project/ }));
    expect(await screen.findByRole('menuitem', { name: /Start from scratch/ })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(await screen.findByRole('menuitem', { name: /General chat/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /Add project/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Open project/i }));
    expect(await screen.findByRole('menuitem', { name: /General chat/ })).toBeInTheDocument();
  });
});

describe('ProjectSelector project list freshness', () => {
  it('refetches projects on every mount so Recent includes chats created since the last new-chat screen', () => {
    trpcCtx.allProjects = [];
    renderWithStore(<ProjectSelector />, createStore());

    expect(trpcCtx.listOptions).toEqual({ refetchOnMount: 'always' });
  });
});
