// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentsSettingsDialogActiveTabAtom } from '@/lib/atoms';
import type { ResourceInfo } from '@/types/resource-info';
import { SettingsSubviewPage } from '../SettingsSubviewPage';
import { ResourceSettingsTab } from './index';

const openInFinderMock = vi.hoisted(() => vi.fn());

// oxlint-disable-next-line anti-slop/no-module-mocking -- the tRPC client needs Electron's preload; the tab only reads projects and the home path
vi.mock('@/lib/trpc', () => ({
  trpc: {
    projects: { list: { useQuery: () => ({ data: [] }) } },
    external: {
      getHomePath: { useQuery: () => ({ data: '/Users/sam' }) },
      openInFinder: { useMutation: () => ({ mutate: openInFinderMock }) },
    },
  },
}));

const CONFIG = {
  noun: 'skills',
  emptyIcon: () => null,
  emptyTitle: 'None',
  emptyBody: '',
  usage: (name: string) => `Mention @${name}`,
  folder: '.claude/skills',
} as const;

const COPY_ACROSS = { noun: 'skill', onCopy: vi.fn() };

function item(name: string, extra: Partial<ResourceInfo> = {}): ResourceInfo {
  const path = `${extra.projectPath ?? '/Users/sam'}/.claude/skills/${name}/SKILL.md`;
  return {
    name,
    type: 'skill',
    enabled: true,
    scope: 'global',
    path,
    description: `${name} description`,
    config: { name, type: 'skill', source: 'claude-code', path, enabled: true },
    ...extra,
  };
}

function renderTab(items: ResourceInfo[]) {
  render(
    <ResourceSettingsTab
      config={CONFIG}
      items={items}
      isLoading={false}
      copyAcross={COPY_ACROSS}
    />,
  );
}

afterEach(() => {
  cleanup();
  openInFinderMock.mockClear();
});

describe('ResourceSettingsTab', () => {
  it('opens the first group and folds each project, keeping same-named folders apart', () => {
    renderTab([
      item('pdf'),
      item('a', { scope: 'project', projectPath: '/work/app' }),
      item('b', { scope: 'project', projectPath: '/personal/app' }),
    ]);

    expect(screen.getByText('pdf')).toBeInTheDocument();
    const folded = screen.getAllByRole('button', { name: 'app 1' });
    expect(folded).toHaveLength(2);
    expect(screen.queryByText('a')).not.toBeInTheDocument();

    fireEvent.click(folded[1]);
    expect(within(screen.getAllByRole('region', { name: 'app' })[1]).getByText('b')).toBeVisible();
  });

  it.each<[string, Partial<ResourceInfo>]>([
    ['Only in Claude', { readableBy: ['claude-code'] }],
    // A copy no tool reads (e.g. under ~/.frink) is still a gap the user can close.
    ['Not shared', {}],
  ])('marks a %s gap and offers to copy it across', (label, extra) => {
    renderTab([item('pdf', extra)]);

    expect(screen.getByText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^pdf/ }));
    expect(screen.getByRole('button', { name: 'Copy across…' })).toBeInTheDocument();
  });

  it.each<[Partial<ResourceInfo>, string]>([
    [{ builtIn: true }, 'Comes with Frink and stays up to date.'],
    [{ followsYou: true }, 'Every AI tool you use can read it.'],
  ])('offers no copy for a row that needs none, and says why in the open row', (extra, note) => {
    renderTab([item('pdf', extra)]);

    fireEvent.click(screen.getByRole('button', { name: /^pdf/ }));

    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy across…' })).not.toBeInTheDocument();
  });

  it('opens each copy of an item from its open row', () => {
    renderTab([
      item('pdf', {
        followsYou: true,
        sources: [
          { source: 'claude-code', path: '/Users/sam/.claude/skills/pdf' },
          { source: 'cursor', path: '/Users/sam/.cursor/skills/pdf' },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /^pdf/ }));

    fireEvent.click(
      screen.getByRole('button', { name: /^Open \/Users\/sam\/\.cursor\/skills\/pdf in / }),
    );

    expect(openInFinderMock).toHaveBeenCalledWith('/Users/sam/.cursor/skills/pdf');
  });

  it('filters by the search', () => {
    renderTab([item('pdf'), item('brand-voice')]);

    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'brand' } });

    expect(screen.queryByText('pdf')).not.toBeInTheDocument();
    expect(screen.getByText('brand-voice')).toBeInTheDocument();
  });

  it("shows a folded project's matches while searching", () => {
    renderTab([item('pdf'), item('brand-voice', { scope: 'project', projectPath: '/work/app' })]);

    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'brand' } });

    expect(screen.getByText('brand-voice')).toBeInTheDocument();
  });

  it('shows the skills folder from the empty state', () => {
    render(
      <ResourceSettingsTab config={CONFIG} items={[]} isLoading={false} copyAcross={COPY_ACROSS} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show skills folder' }));

    expect(openInFinderMock).toHaveBeenCalledWith('/Users/sam/.claude/skills');
  });

  it('keeps a search in Skills out of Agents', () => {
    const store = createStore();
    store.set(agentsSettingsDialogActiveTabAtom, 'skills');
    render(
      <Provider store={store}>
        <SettingsSubviewPage
          title="Skills & agents"
          description=""
          views={[
            { id: 'skills', label: 'Skills' },
            { id: 'agents', label: 'Custom agents' },
          ]}
          renderView={(id) =>
            id === 'skills' ? (
              <ResourceSettingsTab
                config={CONFIG}
                items={[item('pdf'), item('brand-voice')]}
                isLoading={false}
                copyAcross={COPY_ACROSS}
              />
            ) : (
              <ResourceSettingsTab
                config={{ ...CONFIG, noun: 'agents' }}
                items={[item('reviewer', { type: 'agent' }), item('planner', { type: 'agent' })]}
                isLoading={false}
                copyAcross={COPY_ACROSS}
              />
            )
          }
        />
      </Provider>,
    );
    expect(screen.getByRole('button', { name: 'Show skills folder' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'brand' } });
    act(() => store.set(agentsSettingsDialogActiveTabAtom, 'agents'));

    expect(screen.getByLabelText('Search agents')).toHaveValue('');
    expect(screen.getByText('reviewer')).toBeInTheDocument();
    expect(screen.getByText('planner')).toBeInTheDocument();
  });
});
