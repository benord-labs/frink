// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectPicker } from '.';

type Props = ComponentProps<typeof ProjectPicker>;

const PROJECTS: Props['candidates'] = [
  { id: 'api', name: 'api', path: '/work/api' },
  { id: 'web', name: 'Web', path: '/side/web' },
  { id: 'api-fork', name: 'api', path: '/forks/api' },
];

function renderPicker(overrides: Partial<Props> = {}) {
  const onPick = vi.fn();
  render(
    <ProjectPicker
      trigger={<button type="button">Add project</button>}
      candidates={PROJECTS}
      footer="Only changes this tree."
      onPick={onPick}
      {...overrides}
    />,
  );
  return { onPick, user: userEvent.setup() };
}

const trigger = () => screen.getByRole('button', { name: 'Add project' });
/** Each listed row's folder, in order */
const rowPaths = () => screen.queryAllByRole('menuitem').map((row) => row.getAttribute('title'));

afterEach(cleanup);

describe('ProjectPicker', () => {
  it('lists the projects as menu items in the given order, above the footer note', async () => {
    const { user } = renderPicker();

    await user.click(trigger());

    expect(rowPaths()).toEqual(['/work/api', '/side/web', '/forks/api']);
    expect(screen.getByRole('note')).toHaveTextContent(/^Only changes this tree\.$/);
  });

  it('shows the parent folder only beside names another project shares', async () => {
    const { user } = renderPicker();

    await user.click(trigger());
    const [api, web, fork] = screen.getAllByRole('menuitem');

    expect(within(api).getByText('work')).toBeInTheDocument();
    expect(within(fork).getByText('forks')).toBeInTheDocument();
    expect(web).toHaveTextContent(/^Web$/);
  });

  it('shows the parent folder beside a name a project outside the list already has', async () => {
    const { user } = renderPicker({ candidates: PROJECTS.slice(0, 2), takenNames: ['api'] });

    await user.click(trigger());
    const [api, web] = screen.getAllByRole('menuitem');

    expect(within(api).getByText('work')).toBeInTheDocument();
    expect(web).toHaveTextContent(/^Web$/);
  });

  it.each([
    ['a name in any case', 'wEB', ['/side/web']],
    ['a folder', '/FORKS', ['/forks/api']],
  ])('filters by %s', async (_, query, expected) => {
    const { user } = renderPicker();

    await user.click(trigger());
    await user.type(screen.getByRole('textbox', { name: 'Search projects' }), query);

    expect(rowPaths()).toEqual(expected);
  });

  it('lists name matches before folder-only ones, so Enter picks a name', async () => {
    const { user, onPick } = renderPicker({
      candidates: [
        { id: 'billing', name: 'billing', path: '/code/microservices/billing' },
        { id: 'macros', name: 'macros', path: '/tools/macros' },
        { id: 'ros', name: 'ros-service', path: '/code/microservices/ros-service' },
      ],
    });

    await user.click(trigger());
    await user.type(screen.getByRole('textbox', { name: 'Search projects' }), 'ros');

    expect(rowPaths()).toEqual([
      '/code/microservices/ros-service',
      '/tools/macros',
      '/code/microservices/billing',
    ]);
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledExactlyOnceWith('ros');
  });

  it.each([
    ['no other project', { candidates: [] }, '', 'No other projects to add.'],
    ['no project matching', {}, ' zzz ', 'No projects match “zzz”.'],
    [
      'a list still loading',
      { candidates: [], status: 'pending' as const },
      '',
      'Loading projects…',
    ],
    [
      'a list that failed',
      { candidates: [], status: 'error' as const },
      '',
      "Can't load your projects.",
    ],
  ])('says so for %s', async (_, overrides, query, message) => {
    const { user } = renderPicker(overrides);

    await user.click(trigger());
    if (query) await user.type(screen.getByRole('textbox', { name: 'Search projects' }), query);

    expect(rowPaths()).toEqual([]);
    // Announced, since focus stays in the search field
    expect(screen.getByRole('status').textContent).toBe(message);
  });

  it('keeps listing the projects it has when loading them again fails', async () => {
    const { user } = renderPicker({ status: 'error' });

    await user.click(trigger());

    expect(rowPaths()).toEqual(['/work/api', '/side/web', '/forks/api']);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('closes on Escape and gives focus back to its button', async () => {
    const { user, onPick } = renderPicker();

    await user.click(trigger());
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('picks with the keyboard alone, then closes and gives focus back to its button', async () => {
    const { user, onPick } = renderPicker();

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    await user.keyboard('api{ArrowDown}{Enter}');

    expect(onPick).toHaveBeenCalledExactlyOnceWith('api-fork');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();

    // It opens again with the search cleared.
    await user.keyboard('{Enter}');
    expect(rowPaths()).toHaveLength(3);
  });
});
