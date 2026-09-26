// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { agentsSettingsDialogActiveTabAtom, type SettingsTab } from '@/lib/atoms';
import { type SettingsSubview, SettingsSubviewPage, SubviewActions } from './index';

const VIEWS: [SettingsSubview, ...SettingsSubview[]] = [
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Custom agents' },
];

function SearchView({ name }: { name: string }) {
  const [query, setQuery] = useState('');
  return (
    <>
      <SubviewActions>
        <button type="button">{`Action for ${name}`}</button>
      </SubviewActions>
      <input
        aria-label={`Search ${name}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
    </>
  );
}

/** Stands in for the Plugins directory, whose plugin page brings its own h1. */
function DetailView({ onDetailChange }: { onDetailChange: (open: boolean) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const show = (open: boolean) => {
    setIsOpen(open);
    onDetailChange(open);
  };
  return isOpen ? (
    <>
      <h1>Shortcut</h1>
      <button type="button" onClick={() => show(false)}>
        Back
      </button>
    </>
  ) : (
    <button type="button" onClick={() => show(true)}>
      Open detail
    </button>
  );
}

function renderPage(activeTab: SettingsTab = 'skills') {
  const store = createStore();
  store.set(agentsSettingsDialogActiveTabAtom, activeTab);
  render(
    <Provider store={store}>
      <SettingsSubviewPage
        title="Skills & agents"
        description="Page sentence."
        views={VIEWS}
        renderView={(id, onDetailChange) =>
          id === 'agents' ? (
            <DetailView onDetailChange={onDetailChange} />
          ) : (
            <SearchView name={id} />
          )
        }
      />
    </Provider>,
  );
  return store;
}

afterEach(cleanup);

describe('SettingsSubviewPage', () => {
  it('lands a deep link on its sub-view, with that sub-view’s actions under the page sentence', () => {
    renderPage('agents');

    expect(screen.getByRole('tab', { name: 'Custom agents' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Page sentence.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Action for skills' })).not.toBeInTheDocument();
  });

  it('writes the tab atom and keeps focus on the tab it switched to', () => {
    const store = renderPage();
    const agentsTab = screen.getByRole('tab', { name: 'Custom agents' });

    agentsTab.focus();
    fireEvent.mouseDown(agentsTab);

    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('agents');
    // Same element, still focused: the switcher never remounts, so arrow keys keep working.
    expect(screen.getByRole('tab', { name: 'Custom agents' })).toBe(agentsTab);
    expect(document.activeElement).toBe(agentsTab);
  });

  it('puts the active sub-view’s actions in the header', () => {
    renderPage();

    expect(screen.getByRole('button', { name: 'Action for skills' })).toBeInTheDocument();
  });

  it('gives each sub-view its own state', () => {
    const store = renderPage();
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'pdf' } });

    act(() => store.set(agentsSettingsDialogActiveTabAtom, 'agents'));
    act(() => store.set(agentsSettingsDialogActiveTabAtom, 'skills'));

    expect(screen.getByLabelText('Search skills')).toHaveValue('');
  });

  it('leaves the heading to a sub-view page that has its own, and restores it on the way back', () => {
    renderPage('agents');

    fireEvent.click(screen.getByRole('button', { name: 'Open detail' }));

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Skills & agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByRole('heading', { name: 'Skills & agents' })).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });
});
