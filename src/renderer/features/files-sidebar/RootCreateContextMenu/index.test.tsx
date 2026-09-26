// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InlineInput } from '../FileTree/InlineInput';
import { RootCreateContextMenu } from './index';

// InlineInput's file-icon lookup reaches trpc, which needs an Electron preload bridge.
// Deliberately the ONLY mock here — the Radix menu and the focus hook stay real.
vi.mock('../../agents/mentions/agents-file-mention', () => ({
  getFileIconByExtension: () => null,
}));

/**
 * Renders the REAL Radix context menu and the REAL focus handoff. The sibling file-tree
 * suites stub both, so nothing else proves the contract this component exists for.
 *
 * Note on what is actually asserted. InlineInput carries its own onBlur guard that reclaims
 * focus when it lands on an ancestor, so the input ends up focused whether or not the handoff
 * ran — asserting only final focus would pass even with the handoff deleted. What the handoff
 * uniquely buys is that focus never leaves in the first place: without it Radix refocuses the
 * tree container and the guard bounces focus back a frame later. A bounce mid-gesture drops
 * keystrokes and breaks IME composition, so `blurCount === 0` is the load-bearing assertion.
 */
function Harness({ onInputBlur, testId = 'tree' }: { onInputBlur?: () => void; testId?: string }) {
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  return (
    <RootCreateContextMenu onCreate={setCreating}>
      <div data-testid={testId} tabIndex={0} role="tree" aria-label="file tree">
        {creating && (
          <div onBlurCapture={onInputBlur}>
            <InlineInput
              type={creating}
              level={0}
              onConfirm={() => setCreating(null)}
              onCancel={() => setCreating(null)}
            />
          </div>
        )}
      </div>
    </RootCreateContextMenu>
  );
}

async function openRootMenuAndSelect(item: RegExp, onInputBlur?: () => void) {
  const user = userEvent.setup();
  render(<Harness onInputBlur={onInputBlur} />);
  await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('tree') });
  await user.click(await screen.findByText(item));
}

describe('RootCreateContextMenu focus handoff', () => {
  it('hands focus to the inline input after New File without a blur bounce', async () => {
    const inputBlurred = vi.fn();
    await openRootMenuAndSelect(/New File/, inputBlurred);

    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
    expect(inputBlurred).not.toHaveBeenCalled();
  });

  it('hands focus to the inline input after New Folder without a blur bounce', async () => {
    const inputBlurred = vi.fn();
    await openRootMenuAndSelect(/New Folder/, inputBlurred);

    const input = await screen.findByLabelText('New folder name');
    await waitFor(() => expect(input).toHaveFocus());
    expect(inputBlurred).not.toHaveBeenCalled();
  });

  it('keeps the inline input mounted through the menu-dismiss gesture', async () => {
    // InlineInput dismisses itself on outside click; the gesture that selects the menu item
    // must not count as one, or the create is cancelled the instant it starts.
    await openRootMenuAndSelect(/New File/);

    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toBeInTheDocument();
  });

  it('accepts typing immediately, so the first keystrokes are not lost', async () => {
    await openRootMenuAndSelect(/New File/);

    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.setup().keyboard('notes.md');
    expect(input).toHaveValue('notes.md');
  });

  it('hands focus over when the item is chosen by keyboard rather than pointer', async () => {
    // Radix runs a different close path for keyboard selection than for pointer.
    const inputBlurred = vi.fn();
    const user = userEvent.setup();
    render(<Harness onInputBlur={inputBlurred} />);
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('tree') });
    await screen.findByText(/New File/);
    await user.keyboard('{ArrowDown}{Enter}');

    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
    expect(inputBlurred).not.toHaveBeenCalled();
  });
});

describe('RootCreateContextMenu repeated use of the one-shot flag', () => {
  it('re-arms for a second create on the same instance', async () => {
    // The flag is consumed on every close, so a second create must set it again.
    // A one-time-only implementation would focus the first input and strand the second.
    const inputBlurred = vi.fn();
    const user = userEvent.setup();
    render(<Harness onInputBlur={inputBlurred} />);

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('tree') });
    await user.click(await screen.findByText(/New File/));
    const firstInput = await screen.findByLabelText('New file name');
    await waitFor(() => expect(firstInput).toHaveFocus());
    await user.keyboard('{Escape}');

    // Only the second create is under test; the Escape above legitimately blurs the first.
    inputBlurred.mockClear();
    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('tree') });
    await user.click(await screen.findByText(/New Folder/));
    const secondInput = await screen.findByLabelText('New folder name');
    await waitFor(() => expect(secondInput).toHaveFocus());
    expect(inputBlurred).not.toHaveBeenCalled();
  });

  it('restores focus to the tree when the menu is dismissed without choosing anything', async () => {
    // No item selected means no mark, so Radix's default restore must still run.
    const user = userEvent.setup();
    render(<Harness />);
    const tree = screen.getByTestId('tree');

    await user.pointer({ keys: '[MouseRight]', target: tree });
    await screen.findByText(/New File/);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(tree).toHaveFocus());
    expect(screen.queryByLabelText('New file name')).not.toBeInTheDocument();
  });

  it('still hands off after an unselected dismissal', async () => {
    // A close that never marked must not leave the flag in a state that breaks the next create.
    const inputBlurred = vi.fn();
    const user = userEvent.setup();
    render(<Harness onInputBlur={inputBlurred} />);
    const tree = screen.getByTestId('tree');

    await user.pointer({ keys: '[MouseRight]', target: tree });
    await screen.findByText(/New File/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(tree).toHaveFocus());

    await user.pointer({ keys: '[MouseRight]', target: tree });
    await user.click(await screen.findByText(/New File/));
    const input = await screen.findByLabelText('New file name');
    await waitFor(() => expect(input).toHaveFocus());
    expect(inputBlurred).not.toHaveBeenCalled();
  });
});

describe('RootCreateContextMenu across split panes', () => {
  it('focuses the input belonging to the pane whose menu was used', async () => {
    // Frink runs several PaneFileTree instances side by side. Each owns its own handoff
    // state; sharing it (or the creating state) would focus the wrong pane's input.
    const paneBInputBlurred = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <Harness testId="tree-a" />
        <Harness testId="tree-b" onInputBlur={paneBInputBlurred} />
      </>,
    );

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('tree-a') });
    await user.click(await screen.findByText(/New File/));
    await waitFor(() => expect(screen.getByLabelText('New file name')).toHaveFocus());

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('tree-b') });
    await user.click(await screen.findByText(/New Folder/));

    const paneBInput = await screen.findByLabelText('New folder name');
    await waitFor(() => expect(paneBInput).toHaveFocus());
    // Pane A's create was dismissed by clicking away, which is the intended behaviour;
    // what matters is that pane B's input, not pane A's, ended up with the caret, and that
    // pane B's own handoff ran rather than relying on pane A's already-consumed flag.
    expect(screen.getByTestId('tree-b')).toContainElement(paneBInput);
    expect(paneBInputBlurred).not.toHaveBeenCalled();
  });
});
