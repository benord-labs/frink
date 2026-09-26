// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credMutation = vi.hoisted(() => {
  const state = { clearPending: false };
  const clearMutate = vi.fn();
  return { state, clearMutate };
});

vi.mock('../../../../../../lib/trpc', () => ({
  trpc: {
    customNodes: {
      setCredential: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
        }),
      },
      clearCredential: {
        useMutation: () => ({
          mutate: credMutation.clearMutate,
          isPending: credMutation.state.clearPending,
        }),
      },
    },
  },
}));

const { CredentialField } = await import('./index');

afterEach(() => {
  cleanup();
});

describe('CredentialField', () => {
  const defaultProps = {
    nodeName: 'my-node',
    credKey: 'api_key',
    meta: {} as Record<string, never>,
    status: { key: 'api_key', label: 'API key', configured: true },
    onSaved: vi.fn(),
  };

  beforeEach(() => {
    credMutation.state.clearPending = false;
    credMutation.clearMutate.mockClear();
    defaultProps.onSaved.mockClear();
  });

  it('disables Remove saved credential while clearCredential is pending', () => {
    const { rerender } = render(<CredentialField {...defaultProps} />);
    const removeBtn = screen.getByRole('button', { name: /remove saved credential/i });
    expect(removeBtn).not.toBeDisabled();

    credMutation.state.clearPending = true;
    rerender(<CredentialField {...defaultProps} />);
    expect(removeBtn).toBeDisabled();
  });

  it('calls clearCredential mutate with nodeName and key when Remove is clicked', async () => {
    const user = userEvent.setup();
    render(<CredentialField {...defaultProps} />);
    const removeBtn = screen.getByRole('button', { name: /remove saved credential/i });
    await user.click(removeBtn);
    expect(credMutation.clearMutate).toHaveBeenCalledTimes(1);
    expect(credMutation.clearMutate).toHaveBeenCalledWith({
      nodeName: 'my-node',
      key: 'api_key',
    });
  });
});
