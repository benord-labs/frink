// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyableInput } from './index';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CopyableInput', () => {
  it('associates each visible label with its own input and copy action', () => {
    render(
      <>
        <CopyableInput value="https://example.test" label="Webhook address" />
        <CopyableInput value="private-signing-secret" label="Secret" />
      </>,
    );

    expect(screen.getByRole('textbox', { name: 'Webhook address' })).toHaveValue(
      'https://example.test',
    );
    expect(screen.getByLabelText('Secret', { selector: 'input' })).toHaveValue(
      'private-signing-secret',
    );
    expect(screen.getByRole('button', { name: 'Copy Webhook address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Secret' })).toBeInTheDocument();
  });

  it('keeps the field name in copy confirmation without exposing the secret', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyableInput value="private-signing-secret" aria-label="Secret" />);

    expect(screen.getByRole('textbox', { name: 'Secret' })).toHaveValue('private-signing-secret');
    fireEvent.click(screen.getByRole('button', { name: 'Copy Secret' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copied Secret' })).toBeInTheDocument(),
    );
    expect(writeText).toHaveBeenCalledWith('private-signing-secret');
  });

  it('reports Copied only when a copy actually happened', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    document.execCommand = vi.fn().mockReturnValue(false);
    render(<CopyableInput value="https://example.test" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    await Promise.resolve();

    expect(screen.getByRole('button', { name: 'Copy value' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied value' })).not.toBeInTheDocument();
  });
});
