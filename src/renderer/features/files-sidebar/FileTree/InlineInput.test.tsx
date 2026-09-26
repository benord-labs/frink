// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineInput } from './InlineInput';

vi.mock('../../agents/mentions/agents-file-mention', () => ({
  getFileIconByExtension: () => null,
}));

describe('InlineInput', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('focuses create mode on mount without waiting for a timeout', async () => {
    render(<InlineInput type="folder" level={0} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const input = screen.getByRole('textbox');

    await waitFor(() => {
      expect(input).toHaveFocus();
    });
  });

  it('selects the file basename during rename mode', async () => {
    render(
      <InlineInput
        type="file"
        level={1}
        defaultValue="notes.test.tsx"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByDisplayValue('notes.test.tsx') as HTMLInputElement;

    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('notes.test'.length);
  });

  it('rejects path-like names before calling onConfirm', async () => {
    const onConfirm = vi.fn();

    render(<InlineInput type="file" level={0} onConfirm={onConfirm} onCancel={vi.fn()} />);

    const input = screen.getByRole('textbox');

    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    fireEvent.change(input, { target: { value: '../secret.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});
