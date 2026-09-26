// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PickerList } from '.';

type Props = ComponentProps<typeof PickerList>;

const PROJECTS: Props['filteredProjects'] = [
  { id: 'a', name: 'Busy', path: '/repos/busy', lastActiveAt: new Date() },
  { id: 'b', name: 'Quiet', path: '/repos/quiet', lastActiveAt: null },
];

function renderList(overrides: Partial<Props> = {}) {
  const props: Props = {
    searchQuery: '',
    onSearchQueryChange: vi.fn(),
    view: 'list',
    onViewChange: vi.fn(),
    isLoadingProjects: false,
    isNewChatContext: true,
    newChatTarget: 'unset',
    onNewChatTargetChange: vi.fn(),
    validSelection: null,
    filteredProjects: PROJECTS,
    openFolderPending: false,
    clonePending: false,
    onSelectProject: vi.fn(),
    onSetSelectedProject: vi.fn(),
    onClose: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenCloneDialog: vi.fn(),
    ...overrides,
  };
  render(<PickerList {...props} />);
  return props;
}

const itemTexts = () => screen.getAllByRole('menuitem').map((o) => o.textContent);

afterEach(cleanup);

describe('PickerList', () => {
  it('lists General chat, then projects in the given order, then one Add project row', () => {
    renderList();

    expect(itemTexts()).toEqual([
      expect.stringContaining('General chat'),
      expect.stringContaining('Busy'),
      expect.stringContaining('Quiet'),
      expect.stringContaining('Add project'),
    ]);
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('shows a time only for projects that have been used', () => {
    renderList();

    expect(screen.getByRole('menuitem', { name: /Busy/ })).toHaveTextContent('now');
    expect(screen.getByRole('menuitem', { name: /Quiet/ }).textContent).toBe('Quiet');
  });

  it('hides General chat and Add project while searching', () => {
    renderList({ searchQuery: 'bu' });

    expect(screen.queryByText('General chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Add project')).not.toBeInTheDocument();
  });

  it('opens the Add project view from its row', () => {
    const props = renderList();

    fireEvent.click(screen.getByRole('menuitem', { name: /Add project/ }));

    expect(props.onViewChange).toHaveBeenCalledWith('add');
  });

  it('offers the three ways to add a project, wired to the existing actions', () => {
    const props = renderList({ view: 'add' });

    fireEvent.click(screen.getByRole('menuitem', { name: /Start from scratch/ }));
    expect(props.onNewChatTargetChange).toHaveBeenCalledWith('new');
    expect(props.onSetSelectedProject).toHaveBeenCalledWith(null);
    expect(props.onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: /Open a folder/ }));
    expect(props.onOpenFolder).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: /Clone from GitHub/ }));
    expect(props.onOpenCloneDialog).toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('menuitem')[0]);
    expect(props.onViewChange).toHaveBeenCalledWith('list');
  });

  it('keeps the footer actions and no new-chat rows for flow callers', () => {
    renderList({ isNewChatContext: false, onNewChatTargetChange: undefined });

    expect(itemTexts()).toEqual([
      expect.stringContaining('Busy'),
      expect.stringContaining('Quiet'),
    ]);
    expect(screen.getByRole('button', { name: 'Open existing folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clone from GitHub' })).toBeInTheDocument();
  });
});
