// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMention } from '../../../../shared/lib/mentions/parse-mention';
import { AgentsFileMention } from './agents-file-mention';

const state = vi.hoisted(() => ({
  tree: { main: null as { name: string } | null, extras: [] as unknown[] },
  skills: [] as unknown[],
  mainFiles: [] as unknown[],
}));
const useRootSearches = vi.hoisted(() => vi.fn());
const file = (path: string, type: 'file' | 'folder' = 'file') => ({
  id: `${type}:local:${path}`,
  label: path.split('/').pop(),
  path,
  repository: 'local',
  type,
});
const ROS = { id: 'p2', name: 'ros-service', path: '/w/ros-service', missing: false };

// No agents or tools; skills only when a test adds one, so the picker opens straight onto files.
vi.mock('../../../lib/trpc', () => ({
  trpc: {
    skills: { listEnabled: { useQuery: () => ({ data: state.skills }) } },
    agents: { listEnabled: { useQuery: () => ({ data: [] }) } },
  },
}));
vi.mock('../../../lib/mock-api', () => ({
  api: {
    github: {
      searchFiles: {
        useQuery: () => ({ data: state.mainFiles, isLoading: false, isFetching: false }),
      },
    },
  },
}));
vi.mock('@/lib/workspace-context/use-tree-projects', () => ({ useTreeProjects: () => state.tree }));
vi.mock('@/lib/workspace-context/use-root-searches', () => ({ useRootSearches }));

const linkedSearch = (
  results: unknown[],
  busy: { isFetching?: boolean; isLoading?: boolean } = {},
) => useRootSearches.mockReturnValue({ isFetching: false, isLoading: false, results, ...busy });

beforeEach(() => {
  Object.assign(state, {
    tree: { main: { name: 'owners-web' }, extras: [ROS] },
    skills: [],
    mainFiles: [file('app.ts')],
  });
  linkedSearch([[file('src/app.ts')]]);
});
afterEach(cleanup);

type PickerProps = Partial<ComponentProps<typeof AgentsFileMention>>;
function renderPicker(props: PickerProps = {}) {
  const view = (more: PickerProps) => (
    <AgentsFileMention
      isOpen
      onClose={vi.fn()}
      onSelect={vi.fn()}
      searchText=""
      position={{ top: 400, left: 0 }}
      projectPath="/w/owners-web"
      chatId="c1"
      {...props}
      {...more}
    />
  );
  const { rerender } = render(view({}));
  return { rerender: (more: PickerProps = {}) => rerender(view(more)) };
}

/** The dropdown, read in order: each title by its text and each option by its keyboard index */
function outline() {
  const list = screen.getAllByRole('option')[0]?.closest('.overflow-y-auto');
  const nodes = list?.querySelectorAll('[data-option-index], div.font-medium') ?? [];
  return Array.from(nodes, (node) => node.getAttribute('data-option-index') ?? node.textContent);
}

const lastSearch = () => useRootSearches.mock.lastCall;

describe('AgentsFileMention with linked projects', () => {
  it('lists each linked project under its name after the chat’s own and picks its full path', () => {
    state.tree.extras = [ROS, { id: 'p3', name: 'gone', path: '/w/gone', missing: true }];
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    expect(outline()).toEqual(['owners-web', '0', 'ros-service· linked', '1']);
    expect(lastSearch()).toEqual([[expect.objectContaining({ path: '/w/ros-service' })], '', true]);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file:local:/w/ros-service/src/app.ts' }),
    );
  });

  it('picks a changed file as a file the agent is told about, whole even with a stray bracket', () => {
    state.tree.extras = [];
    linkedSearch([]);
    const onSelect = vi.fn();
    const changedFiles = [
      { filePath: 'src/a]b.ts', displayPath: 'src/a]b.ts', additions: 3, deletions: 1 },
    ];
    renderPicker({ onSelect, changedFiles });

    fireEvent.keyDown(window, { key: 'Enter' });
    const [picked] = onSelect.mock.calls[0] ?? [];
    expect(picked).toMatchObject({ label: 'a]b.ts', additions: 3, deletions: 1 });
    expect(parseMention(picked?.id ?? '')).toMatchObject({ type: 'file', path: 'src/a]b.ts' });
  });

  it('keeps the usual header and searches nothing more when the chat links nothing', () => {
    state.tree.extras = [];
    linkedSearch([]);
    renderPicker();

    expect(outline()).toEqual(['Files & Folders', '0']);
    expect(lastSearch()).toEqual([[], '', true]);
  });

  it('names each project’s group for a screen reader, and sizes the list for its headings', () => {
    renderPicker();

    const group = screen.getByRole('group', { name: 'ros-service, linked' });
    expect(within(group).getByRole('option')).toHaveTextContent('app.tssrc');
    expect(screen.getByRole('group', { name: 'owners-web' })).toBeInTheDocument();
    // Two options and two headings, 28px each, and 8px of padding
    expect(screen.getAllByRole('option')[0]?.closest('.overflow-y-auto')).toHaveStyle({
      maxHeight: '120px',
    });
  });

  it('draws a linked folder’s tooltip from its project’s name', () => {
    state.mainFiles = [];
    linkedSearch([[file('src/lib', 'folder')]]);
    renderPicker();

    const tooltip = screen.getByRole('tooltip');
    expect(within(tooltip).getByText('ros-service')).toBeInTheDocument();
    expect(within(tooltip).queryByText('w')).toBeNull();
  });

  it('brings a project’s heading into view with its first option', () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    renderPicker();

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    const heading = screen.getByText('ros-service').parentElement;
    expect(scrolled.mock.contexts).toContain(heading);
    scrolled.mockRestore();
  });

  it('stays on the picked file when the chat’s own results land above it', () => {
    state.mainFiles = [];
    linkedSearch([[file('src/app.ts'), file('src/lib/app.ts')]]);
    const onSelect = vi.fn();
    const { rerender } = renderPicker({ onSelect });
    fireEvent.keyDown(window, { key: 'ArrowDown' });

    state.mainFiles = [file('app.ts'), file('app.test.ts')];
    rerender();
    expect(outline()).toEqual(['owners-web', '0', '1', 'ros-service· linked', '2', '3']);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file:local:/w/ros-service/src/lib/app.ts' }),
    );
  });
});

describe('AgentsFileMention while a linked project is still searching', () => {
  beforeEach(() => {
    state.mainFiles = [];
  });

  it('says files are loading until a linked project has its first results', () => {
    linkedSearch([undefined], { isFetching: true, isLoading: true });
    renderPicker({ searchText: 'foo' });

    expect(screen.getByText('Loading files...')).toBeInTheDocument();
  });

  it('holds back “no files” until every linked project’s search settles', () => {
    linkedSearch([[]], { isFetching: true });
    const { rerender } = renderPicker();
    expect(screen.queryByText(/No files/)).toBeNull();

    linkedSearch([[]]);
    rerender();
    expect(screen.getByText('No files found')).toBeInTheDocument();
  });
});

describe('AgentsFileMention with linked projects and skills', () => {
  beforeEach(() => {
    state.skills = [
      { name: 'apply', description: 'Apply a patch', path: '/s/apply', source: 'user' },
    ];
  });

  it('leaves linked projects out of the skills list and unsearched', () => {
    renderPicker({ showingSkillsList: true });

    expect(outline()).toEqual(['Skills', '0']);
    expect(lastSearch()?.[2]).toBe(false);
  });

  it('leaves linked projects out of the categories and unsearched until something is typed', () => {
    renderPicker();

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Files & Folders',
      'Skills',
    ]);
    expect(screen.queryByText('ros-service')).toBeNull();
    expect(lastSearch()?.[2]).toBe(false);
  });

  it('keeps skills under Results and each project’s files under its name in a search', () => {
    renderPicker({ searchText: 'ap' });

    expect(outline()).toEqual(['Results', '0', 'owners-web', '1', 'ros-service· linked', '2']);
    expect(lastSearch()?.[2]).toBe(true);
  });
});
