// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import { customHotkeysAtom } from '../../../lib/atoms';
import { AgentsKeyboardTab } from './agents-keyboard-tab';

function renderTab(setup?: (store: ReturnType<typeof createStore>) => void) {
  const store = createStore();
  setup?.(store);
  render(
    <Provider store={store}>
      <AgentsKeyboardTab />
    </Provider>,
  );
  return store;
}

function pressCombo(modifiers: string | string[], key: string): void {
  act(() => {
    for (const modifier of [modifiers].flat()) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: modifier }));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key }));
  });
}

describe('AgentsKeyboardTab', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('records a new binding inline and resets it back to the default', () => {
    const store = renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Change Toggle sidebar' }));
    pressCombo('Meta', '9');

    expect(store.get(customHotkeysAtom).bindings['toggle-sidebar']).toBe('cmd+9');

    fireEvent.click(screen.getByRole('button', { name: 'Reset Toggle sidebar to default' }));
    expect(store.get(customHotkeysAtom).bindings['toggle-sidebar']).toBeUndefined();
  });

  it('refuses a combination another shortcut already uses', () => {
    const store = renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Change Toggle sidebar' }));
    pressCombo('Meta', ',');

    expect(screen.getByRole('alert').textContent).toBe('Already used by “Settings”');
    expect(store.get(customHotkeysAtom).bindings['toggle-sidebar']).toBeUndefined();
  });

  it('treats an alternate binding as taken', () => {
    const store = renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Change Toggle sidebar' }));
    pressCombo('Control', 'c');

    expect(screen.getByRole('alert').textContent).toBe('Already used by “Stop generation”');
    expect(store.get(customHotkeysAtom).bindings['toggle-sidebar']).toBeUndefined();
  });

  it('does not count bindings stored as null in the reset-all total', () => {
    renderTab((store) =>
      store.set(customHotkeysAtom, {
        version: 1,
        bindings: { 'toggle-sidebar': null, 'open-settings': 'cmd+9' },
      }),
    );

    expect(screen.getByRole('button', { name: /Reset 1 changed/ })).toBeTruthy();
  });

  it('hands a combination to the row, not the search, when a row is clicked during search-by-keys', () => {
    const store = renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Search by pressing a shortcut' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change Toggle sidebar' }));
    pressCombo('Meta', '9');

    expect(store.get(customHotkeysAtom).bindings['toggle-sidebar']).toBe('cmd+9');
    expect(screen.getByLabelText('Search shortcuts')).toHaveProperty('value', '');
  });

  it('starts a fresh recording when switching rows mid-keypress', () => {
    const store = renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Change Toggle sidebar' }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '9' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change Settings' }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: '9' }));
    });

    expect(store.get(customHotkeysAtom).bindings).toEqual({});
  });

  it('searches Cmd+Shift+= as Cmd+Plus', () => {
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Search by pressing a shortcut' }));
    pressCombo(['Meta', 'Shift'], '+');

    expect(screen.getByLabelText('Search shortcuts')).toHaveProperty('value', 'cmd+plus');
  });

  it('filters the list by search text', () => {
    renderTab();

    fireEvent.change(screen.getByLabelText('Search shortcuts'), {
      target: { value: 'toggle sidebar' },
    });

    expect(screen.getByText('Toggle sidebar')).toBeTruthy();
    expect(screen.queryByText('Settings')).toBeNull();
  });
});
