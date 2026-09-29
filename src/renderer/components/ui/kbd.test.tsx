// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { createRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customHotkeysAtom } from '../../lib/atoms';

// Mutable per-test OS switch — Kbd renders glyphs on macOS and text elsewhere.
const platformMock = vi.hoisted(() => ({ isMacOS: vi.fn(() => false) }));
vi.mock('@/lib/utils/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/platform')>();
  return { ...actual, isMacOS: platformMock.isMacOS };
});

import { Kbd } from './kbd';

function renderWithStore(ui: ReactNode, bindings: Record<string, string | null> = {}) {
  const store = createStore();
  store.set(customHotkeysAtom, { version: 1, bindings });
  const result = render(<Provider store={store}>{ui}</Provider>);
  return { store, ...result };
}

function kbdElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('kbd'));
}

describe('Kbd', () => {
  beforeEach(() => {
    platformMock.isMacOS.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  describe('aria-label follows the resolved binding', () => {
    it('labels the default binding in text form', () => {
      const { container } = renderWithStore(<Kbd shortcutId="toggle-sidebar" />);
      const [kbd] = kbdElements(container);
      expect(kbd.getAttribute('aria-label')).toBe('Ctrl+B');
      expect(kbd.textContent).toBe('Ctrl+B');
    });

    it('labels a user-customised binding, not the default', () => {
      const { container } = renderWithStore(<Kbd shortcutId="toggle-sidebar" />, {
        'toggle-sidebar': 'cmd+shift+9',
      });
      const [kbd] = kbdElements(container);
      expect(kbd.getAttribute('aria-label')).toBe('Ctrl+Shift+9');
      expect(kbd.textContent).toBe('Ctrl+Shift+9');
    });

    it('drops the label when the user unbinds the shortcut', () => {
      const { container } = renderWithStore(<Kbd shortcutId="toggle-sidebar" />, {
        'toggle-sidebar': null,
      });
      const [kbd] = kbdElements(container);
      expect(kbd.hasAttribute('aria-label')).toBe(false);
      expect(kbd.textContent).toBe('');
    });

    it('updates every mounted instance when the binding changes after mount', () => {
      // Multi-pane layouts mount several Kbd hints for the same action at once.
      const { container, store } = renderWithStore(
        <>
          <Kbd shortcutId="toggle-sidebar" />
          <Kbd shortcutId="toggle-sidebar" />
        </>,
      );

      act(() => {
        store.set(customHotkeysAtom, { version: 1, bindings: { 'toggle-sidebar': 'opt+K' } });
      });

      for (const kbd of kbdElements(container)) {
        expect(kbd.getAttribute('aria-label')).toBe('Alt+K');
        expect(kbd.textContent).toBe('Alt+K');
      }

      act(() => {
        store.set(customHotkeysAtom, { version: 1, bindings: { 'toggle-sidebar': null } });
      });

      for (const kbd of kbdElements(container)) {
        expect(kbd.hasAttribute('aria-label')).toBe(false);
      }
    });

    it('lets a caller-supplied aria-label win over the resolved one', () => {
      const { container } = renderWithStore(
        <Kbd shortcutId="toggle-sidebar" aria-label="Toggle the sidebar" />,
      );
      expect(kbdElements(container)[0].getAttribute('aria-label')).toBe('Toggle the sidebar');
    });
  });

  describe('macOS', () => {
    beforeEach(() => {
      platformMock.isMacOS.mockReturnValue(true);
    });

    it('renders glyph icons but announces modifiers by their Mac names', () => {
      const { container } = renderWithStore(<Kbd shortcutId="toggle-sidebar" />, {
        'toggle-sidebar': 'cmd+shift+9',
      });
      const [kbd] = kbdElements(container);
      expect(kbd.querySelectorAll('svg').length).toBe(2);
      expect(kbd.getAttribute('aria-label')).toBe('Command+Shift+9');
    });

    it('announces Cmd and Ctrl bindings differently', () => {
      const { container } = renderWithStore(
        <>
          <Kbd shortcutId="toggle-sidebar" />
          <Kbd shortcutId="search-workspaces" />
        </>,
        { 'search-workspaces': 'ctrl+opt+K' },
      );
      const [sidebar, search] = kbdElements(container);
      expect(sidebar.getAttribute('aria-label')).toBe('Command+B');
      expect(search.getAttribute('aria-label')).toBe('Control+Option+K');
    });
  });

  describe('registry-backed toolbar hints', () => {
    it.each([
      [false, 'Esc'],
      [true, 'Esc'],
    ])('shows "Esc" for editor-close-panel (mac=%s)', (mac, expected) => {
      platformMock.isMacOS.mockReturnValue(mac);
      const { container } = renderWithStore(<Kbd shortcutId="editor-close-panel" />);
      const [kbd] = kbdElements(container);
      expect(kbd.textContent).toBe(expected);
      expect(kbd.getAttribute('aria-label')).toBe(expected);
    });
  });

  describe('element wiring', () => {
    it('forwards the ref and merges className on the registry-backed path', () => {
      const ref = createRef<HTMLElement>();
      const { container } = renderWithStore(
        <Kbd ref={ref} shortcutId="toggle-sidebar" className="extra" />,
      );
      const [kbd] = kbdElements(container);
      expect(ref.current).toBe(kbd);
      expect(kbd.className).toContain('extra');
      expect(kbd.className).toContain('text-muted-foreground/60');
    });

    it('forwards the ref and merges className on the literal-children path', () => {
      const ref = createRef<HTMLElement>();
      const { container } = renderWithStore(
        <Kbd ref={ref} className="extra">
          ⌘K
        </Kbd>,
      );
      const [kbd] = kbdElements(container);
      expect(ref.current).toBe(kbd);
      expect(kbd.className).toContain('extra');
      expect(kbd.className).toContain('text-muted-foreground/60');
    });

    it('renders literal children without an aria-label when no shortcutId is given', () => {
      const { container } = renderWithStore(<Kbd>⌘K</Kbd>);
      const [kbd] = kbdElements(container);
      expect(kbd.hasAttribute('aria-label')).toBe(false);
      expect(kbd.querySelector('svg')).not.toBeNull();
      expect(kbd.textContent).toBe('K');
    });
  });
});
