// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRow } from './index';

// ApiKeyEditForm only renders in the (unused-here) `isEditing` credential path,
// but its module-top `trpc` import needs the Electron IPC bridge, absent under
// happy-dom. Stub it so importing AccountRow doesn't drag in that chain.
vi.mock('./ApiKeyEditForm', () => ({ ApiKeyEditForm: () => null }));

// Pass-through the dropdown-menu primitives so `DropdownMenuTrigger asChild`
// renders the real actions Button inline — its native ref (actionsRef) is what
// focus-return relies on and is the behavior under test, so it must stay real.
vi.mock('../../../../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function makeAccount(overrides: Partial<Parameters<typeof AccountRow>[0]['account']> = {}) {
  return {
    id: 'acc-1',
    label: 'Personal',
    isDefault: false,
    isAuthenticated: true,
    connectedAt: null,
    ...overrides,
  };
}

function renderRow(props: Partial<Parameters<typeof AccountRow>[0]> = {}) {
  const onSaveRename = vi.fn();
  const onCancelRename = vi.fn();
  render(
    <AccountRow
      account={makeAccount(props.account)}
      isEditingRename
      renamePending={false}
      onSetDefault={vi.fn()}
      onDelete={vi.fn()}
      onAuthenticate={vi.fn()}
      onRenameClick={vi.fn()}
      onSaveRename={onSaveRename}
      onCancelRename={onCancelRename}
      {...props}
    />,
  );
  return {
    onSaveRename,
    onCancelRename,
    input: screen.getByRole('textbox', { name: 'Account name' }),
    actionsButton: screen.getByRole('button', { name: /^More for / }),
  };
}

afterEach(cleanup);

describe('AccountRow rename behavior', () => {
  it('saves the trimmed label and returns focus to the actions button on Enter', async () => {
    const user = userEvent.setup();
    const { onSaveRename, input, actionsButton } = renderRow();

    await user.clear(input);
    await user.type(input, '  Work Account  ');
    await user.keyboard('{Enter}');

    expect(onSaveRename).toHaveBeenCalledTimes(1);
    expect(onSaveRename).toHaveBeenCalledWith('acc-1', 'Work Account');
    expect(actionsButton).toHaveFocus();
  });

  it('cancels and returns focus to the actions button on Escape', async () => {
    const user = userEvent.setup();
    const { onCancelRename, onSaveRename, input, actionsButton } = renderRow();

    input.focus();
    await user.keyboard('{Escape}');

    expect(onCancelRename).toHaveBeenCalledTimes(1);
    expect(onSaveRename).not.toHaveBeenCalled();
    expect(actionsButton).toHaveFocus();
  });

  it('does not save on Enter when the draft is unchanged (canSave is false)', async () => {
    const user = userEvent.setup();
    const { onSaveRename, input } = renderRow();

    // Draft still equals the current label — Enter must be inert. Focus
    // legitimately stays on the input, so we only assert the save was skipped.
    input.focus();
    await user.keyboard('{Enter}');

    expect(onSaveRename).not.toHaveBeenCalled();
  });

  it('keeps Save disabled until a valid change, then saves the trimmed label and refocuses on click', async () => {
    const user = userEvent.setup();
    const { onSaveRename, input, actionsButton } = renderRow();
    const saveButton = screen.getByRole('button', { name: 'Save' });

    // Draft still equals the current label on mount.
    expect(saveButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, '  Work Account  ');
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);
    expect(onSaveRename).toHaveBeenCalledTimes(1);
    expect(onSaveRename).toHaveBeenCalledWith('acc-1', 'Work Account');
    expect(actionsButton).toHaveFocus();
  });

  it('discards the edit and returns focus to the actions button when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onCancelRename, onSaveRename, actionsButton } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancelRename).toHaveBeenCalledTimes(1);
    expect(onSaveRename).not.toHaveBeenCalled();
    expect(actionsButton).toHaveFocus();
  });

  it('disables Save and Cancel while a rename is in flight (guards double-submit / mid-flight cancel)', () => {
    renderRow({ renamePending: true });

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('treats a whitespace-only draft as no change: Save stays disabled and Enter is inert', async () => {
    const user = userEvent.setup();
    const { onSaveRename, input } = renderRow();

    await user.clear(input);
    await user.type(input, '   ');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(onSaveRename).not.toHaveBeenCalled();
  });
});

describe('AccountRow summary', () => {
  it('marks the default account and shows the signed-in email', () => {
    render(
      <AccountRow
        account={makeAccount({ isDefault: true, expectedEmail: 'me@example.com' })}
        onSetDefault={vi.fn()}
        onDelete={vi.fn()}
        onAuthenticate={vi.fn()}
        onRenameClick={vi.fn()}
        onSaveRename={vi.fn()}
        onCancelRename={vi.fn()}
      />,
    );
    expect(screen.getByText('Used for new chats')).toBeInTheDocument();
    expect(screen.getByText('Claude · me@example.com')).toBeInTheDocument();
  });

  it('offers the one fix for a key-less API account', async () => {
    const onAuthenticate = vi.fn();
    render(
      <AccountRow
        account={makeAccount({ isApiKey: true, isAuthenticated: false })}
        onSetDefault={vi.fn()}
        onDelete={vi.fn()}
        onAuthenticate={onAuthenticate}
        onRenameClick={vi.fn()}
        onSaveRename={vi.fn()}
        onCancelRename={vi.fn()}
      />,
    );
    expect(screen.getByText('Claude · Needs an API key')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add key' }));
    expect(onAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc-1' }));
  });
});
