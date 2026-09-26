// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FolderOpen } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsEmptyState,
  SettingsFoldGroup,
  SettingsList,
  SettingsListRow,
  SoftButton,
} from './index';

function renderRow(props: { expanded?: boolean; menu?: boolean; onToggle?: () => void } = {}) {
  render(
    <SettingsList>
      <SettingsListRow
        id="pdf"
        name="pdf"
        description="Reads PDFs."
        status={<span>Built-in</span>}
        expanded={props.expanded ?? false}
        onToggle={props.onToggle ?? vi.fn()}
        menu={props.menu ? <span>Menu item</span> : undefined}
        details={<p>Row details</p>}
      />
    </SettingsList>,
  );
}

afterEach(cleanup);

describe('SettingsList', () => {
  it('shows name, description and status on a closed row and opens it on click', () => {
    const onToggle = vi.fn();
    renderRow({ onToggle });

    const row = screen.getByRole('button', { name: /^pdf/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveTextContent('Reads PDFs.');
    expect(row).toHaveTextContent('Built-in');
    expect(screen.queryByText('Row details')).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the details of an opened row', () => {
    renderRow({ expanded: true });

    expect(screen.getByRole('button', { name: /^pdf/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Row details')).toBeInTheDocument();
  });

  it('offers a ⋯ menu only on rows that have one', () => {
    renderRow();
    expect(screen.queryByRole('button', { name: 'More actions for pdf' })).not.toBeInTheDocument();
    cleanup();

    renderRow({ menu: true });
    expect(screen.getByRole('button', { name: 'More actions for pdf' })).toBeInTheDocument();
  });

  it('renders an empty state with its action', () => {
    const onClick = vi.fn();
    render(
      <SettingsEmptyState
        icon={FolderOpen}
        title="No skills yet"
        body="Add one to your skills folder."
        action={<SoftButton onClick={onClick}>Show skills folder</SoftButton>}
      />,
    );

    expect(screen.getByText('No skills yet')).toBeInTheDocument();
    expect(screen.getByText('Add one to your skills folder.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show skills folder' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  describe('SettingsFoldGroup', () => {
    const names = Array.from({ length: 13 }, (_, i) => `server-${i + 1}`);

    function fold(
      props: {
        items?: string[];
        defaultOpen?: boolean;
        forceOpen?: boolean;
        revealKey?: string;
      } = {},
    ) {
      return (
        <SettingsFoldGroup
          title="Turned off"
          items={props.items ?? names}
          itemKey={(name) => name}
          renderItem={(name) => (
            <li>
              <button type="button">{name}</button>
            </li>
          )}
          defaultOpen={props.defaultOpen ?? false}
          forceOpen={props.forceOpen}
          revealKey={props.revealKey}
        />
      );
    }

    function renderFold(props: Parameters<typeof fold>[0] = {}) {
      return render(fold(props));
    }

    it('folds to its title and count, and opens on click', () => {
      renderFold();

      const heading = screen.getByRole('button', { name: 'Turned off 13' });
      expect(heading).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('server-1')).not.toBeInTheDocument();

      fireEvent.click(heading);
      expect(heading).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('server-1')).toBeInTheDocument();
    });

    it('shows the first ten rows, then reveals the rest and focuses the first new one', () => {
      renderFold({ defaultOpen: true });

      expect(screen.getByText('server-10')).toBeInTheDocument();
      expect(screen.queryByText('server-11')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));

      expect(screen.getByText('server-13')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'server-11' })).toHaveFocus();
      expect(screen.queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument();
    });

    it('holds a folded group open while searching, keeping the cap', () => {
      renderFold({ forceOpen: true });

      expect(screen.getByText('server-10')).toBeInTheDocument();
      expect(screen.queryByText('server-11')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Turned off 13' })).toBeDisabled();
    });

    it('opens past the cap to show the opened row when it moves in, and gives it focus', () => {
      const { rerender } = renderFold({ items: names.slice(0, 12) });
      expect(screen.queryByText('server-1')).not.toBeInTheDocument();

      rerender(fold({ items: names, revealKey: 'server-13' }));

      expect(screen.getByRole('button', { name: 'server-13' })).toHaveFocus();
    });

    it('lifts the cap when the opened row lands past it without changing group', () => {
      const { rerender } = renderFold({
        items: ['server-13'],
        defaultOpen: true,
        revealKey: 'server-13',
      });

      rerender(fold({ items: names, defaultOpen: true, revealKey: 'server-13' }));

      expect(screen.getByText('server-13')).toBeInTheDocument();
    });

    it('stays folded once the user folds it over the opened row', () => {
      renderFold({ revealKey: 'server-2' });
      const heading = screen.getByRole('button', { name: 'Turned off 13' });
      expect(heading).toHaveAttribute('aria-expanded', 'true');

      fireEvent.click(heading);
      expect(screen.queryByText('server-2')).not.toBeInTheDocument();
    });
  });
});
