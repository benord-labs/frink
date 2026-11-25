// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'jotai';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  codeEditorOpenAtom,
  fileKey,
  openFileAtom,
  openFilesAtom,
  pendingCloseKeysAtom,
  promptReturnFocusAtom,
  updateFileContentAtom,
} from '@/lib/code-editor/state';
import { appStore } from '@/lib/jotai-store';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { CodeEditorPanel, UnsavedChangesPrompt } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

MotionGlobalConfig.skipAnimations = true;

afterEach(() => {
  cleanup();
  appStore.set(openFilesAtom, []);
  appStore.set(pendingCloseKeysAtom, null);
});

const dirty = fileKey('src/dirty.ts', '/repo');

/** Monaco needs a canvas and workers; the panel's tab and close wiring does not. */
function StandInEditor() {
  return <div />;
}

/** The panel (and the app's root prompt) over two pinned tabs, with an unsaved edit in dirty.ts. */
function renderPanel() {
  for (const name of ['clean.ts', 'dirty.ts']) {
    appStore.set(openFileAtom, {
      path: `src/${name}`,
      name,
      content: 'saved',
      projectPath: '/repo',
      intent: 'pinned',
    });
  }
  appStore.set(updateFileContentAtom, { key: dirty, content: 'edited' });
  renderWithTrpc(
    <Provider store={appStore}>
      <TooltipProvider>
        <CodeEditorPanel Editor={StandInEditor} />
        <UnsavedChangesPrompt />
      </TooltipProvider>
    </Provider>,
    async () => null,
  );
}

const pressCmdW = () =>
  act(() => {
    fireEvent.keyDown(document, { key: 'w', metaKey: true, ctrlKey: true });
  });

describe('UnsavedChangesPrompt', () => {
  it('hands focus back to the editor the panel registered once the root prompt is answered', async () => {
    const focus = vi.fn();
    appStore.set(promptReturnFocusAtom, { focus });
    renderWithTrpc(
      <Provider store={appStore}>
        <UnsavedChangesPrompt />
      </Provider>,
      async () => null,
    );
    await act(() => {
      appStore.set(pendingCloseKeysAtom, [dirty]);
    });

    await screen.findByRole('alertdialog');
    await act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    appStore.set(promptReturnFocusAtom, null);
  });
});

describe('CodeEditorPanel closing tabs', () => {
  it('asks before Cmd+W closes the unsaved tab', async () => {
    renderPanel();

    await pressCmdW();

    expect(await screen.findByText('Save changes to dirty.ts?')).toBeInTheDocument();
    expect(appStore.get(openFilesAtom).map((f) => f.name)).toEqual(['clean.ts', 'dirty.ts']);
  });

  it('closes a saved tab from its close button without asking', () => {
    renderPanel();
    const cleanTab = screen.getByRole('tab', { name: /clean\.ts/ });

    fireEvent.click(within(cleanTab).getByRole('button', { name: 'Close tab' }));

    expect(appStore.get(openFilesAtom).map((f) => fileKey(f.path, f.projectPath))).toEqual([dirty]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps asking after the editor panel is hidden', async () => {
    renderPanel();
    await pressCmdW();

    await act(() => {
      appStore.set(codeEditorOpenAtom, false);
    });

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('keeps the editor open when Escape answers the prompt', async () => {
    renderPanel();
    await pressCmdW();
    await screen.findByRole('alertdialog');

    await act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(appStore.get(codeEditorOpenAtom)).toBe(true);
  });
});
