// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { atom, createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentsSidebarWidthAtom } from '@/lib/atoms';
import { themeEditorSessionAtom } from './editor-atoms';
import { useDockGlide, useThemeEditorYield } from './use-theme-editor-dock';

afterEach(() => vi.restoreAllMocks());

describe('useDockGlide', () => {
  it('glides between the closed and open widths, except under reduced motion', () => {
    const dock = document.createElement('div');
    let width = 0;
    vi.spyOn(dock, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 1));
    const animate = vi.fn();
    dock.animate = animate;
    const { result, rerender } = renderHook(({ open }) => useDockGlide(open), {
      initialProps: { open: false },
    });
    result.current.current = dock;

    width = 372;
    rerender({ open: true });
    expect(animate).toHaveBeenLastCalledWith(
      { width: ['0px', '372px'] },
      expect.objectContaining({ duration: 220 }),
    );
    width = 0;
    rerender({ open: false });
    expect(animate).toHaveBeenLastCalledWith({ width: ['372px', '0px'] }, expect.anything());

    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
      Object.defineProperty(matchMedia(query), 'matches', { value: true }),
    );
    width = 372;
    rerender({ open: true });
    expect(animate).toHaveBeenCalledTimes(2);
  });
});

describe('useDockGlide mid-glide', () => {
  it('turns a running glide back from where it is; the next starts from the settled width', () => {
    const dock = document.createElement('div');
    let width = 0;
    let settled = 0;
    vi.spyOn(dock, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 1));
    const glide = {
      playState: 'running',
      cancel: vi.fn(() => {
        width = settled;
      }),
    };
    const animate = vi.fn();
    animate.mockReturnValue(glide);
    dock.animate = animate;
    const { result, rerender } = renderHook(({ open }) => useDockGlide(open), {
      initialProps: { open: false },
    });
    result.current.current = dock;

    width = settled = 372;
    rerender({ open: true });
    // Closed mid-glide: the dock is 180px wide now and settles at 0 once the glide is cancelled.
    width = 180;
    settled = 0;
    rerender({ open: false });
    expect(glide.cancel).toHaveBeenCalled();
    expect(animate).toHaveBeenLastCalledWith({ width: ['180px', '0px'] }, expect.anything());

    glide.playState = 'finished';
    width = settled = 372;
    rerender({ open: true });
    expect(animate).toHaveBeenLastCalledWith({ width: ['0px', '372px'] }, expect.anything());
  });
});

describe('useThemeEditorYield', () => {
  it('folds the file tree, then the sidebar, by their own widths while the editor is open', () => {
    const store = createStore();
    store.set(agentsSidebarWidthAtom, 340);
    const filesWidthAtom = atom(272);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    const { result, rerender } = renderHook(
      ({ sidebarOpen }) => useThemeEditorYield(sidebarOpen, filesWidthAtom),
      { wrapper, initialProps: { sidebarOpen: true } },
    );
    const at = (px: number) => {
      width.mockReturnValue(px);
      act(() => void window.dispatchEvent(new Event('resize')));
      return result.current;
    };
    expect(result.current).toEqual({ files: 'contents', sidebar: '', inset: true });

    act(() =>
      store.set(themeEditorSessionAtom, {
        mode: 'create',
        appearance: 'dark',
        seed: {
          id: 'mine',
          name: 'Mine',
          light: { background: '#ffffff', accent: '#0034ff', syntax: 'github-light' },
          dark: { background: '#050505', accent: '#a78bfa', syntax: 'github-dark' },
        },
      }),
    );
    // Beside the 372px dock the chat keeps 366px: its 350px floor plus the row's gaps.
    expect(at(1440)).toEqual({ files: 'contents', sidebar: '', inset: true });
    expect(at(1100)).toEqual({ files: 'hidden', sidebar: '', inset: true });
    // Nothing is left beside the main pane, so its inset would be a dead strip at the window edge.
    expect(at(1000)).toEqual({ files: 'hidden', sidebar: 'hidden', inset: false });
    rerender({ sidebarOpen: false });
    expect(at(1100)).toEqual({ files: 'contents', sidebar: '', inset: true });
    expect(at(900)).toEqual({ files: 'hidden', sidebar: 'hidden', inset: false });
    // A closed sidebar narrower than the file tree: only the tree folds, and it was the inset.
    act(() => store.set(agentsSidebarWidthAtom, 200));
    expect(at(990)).toEqual({ files: 'hidden', sidebar: '', inset: false });
  });
});
