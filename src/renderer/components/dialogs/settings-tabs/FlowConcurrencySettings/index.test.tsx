// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowConcurrencySettings } from './index';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  refresh: vi.fn(async (): Promise<void> => undefined),
  reset: vi.fn(),
  onSuccess: undefined as ((saved: unknown) => Promise<void>) | undefined,
  refetch: vi.fn(async () => undefined),
  query: {
    data: undefined as
      | {
          concurrency_limit_enabled: boolean;
          max_concurrent_runs: number;
          occupied_runs: number;
          queued_runs: number;
          draining: boolean;
        }
      | undefined,
    error: null as Error | null,
    isLoading: false,
  },
  mutation: {
    error: null as Error | null,
    isPending: false,
  },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      flows: { getAdmissionSettings: { refetch: mocks.refresh } },
    }),
    flows: {
      getAdmissionSettings: {
        useQuery: () => ({ ...mocks.query, refetch: mocks.refetch }),
      },
      updateAdmissionSettings: {
        useMutation: (options: { onSuccess: typeof mocks.onSuccess }) => {
          mocks.onSuccess = options.onSuccess;
          return { ...mocks.mutation, mutate: mocks.mutate, reset: mocks.reset };
        },
      },
    },
  },
}));

describe('FlowConcurrencySettings', () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.refetch.mockClear();
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.reset.mockReset().mockImplementation(() => {
      mocks.mutation.error = null;
    });
    mocks.query.data = {
      concurrency_limit_enabled: true,
      max_concurrent_runs: 4,
      occupied_runs: 4,
      queued_runs: 2,
      draining: true,
    };
    mocks.query.error = null;
    mocks.query.isLoading = false;
    mocks.mutation.error = null;
    mocks.mutation.isPending = false;
  });

  it('keeps edits local until Save submits both settings, including the new maximum', () => {
    render(<FlowConcurrencySettings />);
    expect(screen.getByText('4 / 4 · draining · 2 queued')).toBeTruthy();
    expect(screen.getByText(/Paused Flows and questions keep their slot/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    const maximum = screen.getByRole('spinbutton', { name: 'Maximum parallel runs' });
    expect(maximum.getAttribute('max')).toBe('100');
    fireEvent.change(maximum, { target: { value: '100' } });
    fireEvent.blur(maximum);
    fireEvent.keyDown(maximum, { key: 'Enter' });
    fireEvent.click(screen.getByRole('switch', { name: 'Limit parallel Flow runs' }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      concurrency_limit_enabled: false,
      max_concurrent_runs: 100,
    });
  });

  it.each(['', '0', '101', '1.5'])('rejects invalid maximum %j only on Save', (value) => {
    render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toContain('Enter a whole number from 1 to 100.');
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('4');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves both drafts while polling and discards to the newest saved settings', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('switch'));
    mocks.query.data = { ...mocks.query.data!, max_concurrent_runs: 12, occupied_runs: 8 };
    rerender(<FlowConcurrencySettings />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('100');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('8 / 12 · draining · 2 queued')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('12');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('saves only an edited maximum when another client changes the toggle', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    mocks.query.data = { ...mocks.query.data!, concurrency_limit_enabled: false };
    rerender(<FlowConcurrencySettings />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({ max_concurrent_runs: 100 });
  });

  it('saves only an edited toggle when another client changes the maximum', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    fireEvent.click(screen.getByRole('switch'));
    mocks.query.data = { ...mocks.query.data!, max_concurrent_runs: 100 };
    rerender(<FlowConcurrencySettings />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('100');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({ concurrency_limit_enabled: false });
  });

  it('keeps a matching poll visibly unsaved until the user saves or discards', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    mocks.query.data = { ...mocks.query.data!, max_concurrent_runs: 100 };
    rerender(<FlowConcurrencySettings />);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    mocks.query.data = { ...mocks.query.data!, max_concurrent_runs: 80 };
    rerender(<FlowConcurrencySettings />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('100');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({ max_concurrent_runs: 100 });
  });

  it('keeps other drafted fields when one field is edited after a matching poll', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    mocks.query.data = { ...mocks.query.data!, max_concurrent_runs: 100 };
    rerender(<FlowConcurrencySettings />);
    fireEvent.click(screen.getByRole('switch'));
    mocks.query.data = { ...mocks.query.data!, max_concurrent_runs: 80 };
    rerender(<FlowConcurrencySettings />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('100');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      concurrency_limit_enabled: false,
      max_concurrent_runs: 100,
    });
  });

  it('adopts future polls after edits are reverted to their saved values', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    mocks.query.data = { ...mocks.query.data!, max_concurrent_runs: 7 };
    rerender(<FlowConcurrencySettings />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7');
  });

  it('retains failed saves for retry and clears errors when discarded', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    mocks.mutation.error = new Error('Could not save settings');
    rerender(<FlowConcurrencySettings />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('100');
    expect(screen.getByRole('alert').textContent).toContain('Could not save settings');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('4');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refreshes current settings before clearing a saved draft instead of publishing a stale response', async () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    let finishRefresh!: () => void;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const staleResponse = { ...mocks.query.data!, max_concurrent_runs: 100 };
    await act(async () => {
      const saving = mocks.onSuccess!(staleResponse);
      expect(mocks.refresh).toHaveBeenCalledWith(undefined, undefined, { throwOnError: true });
      expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('100');
      // A concurrent client changed the settings after this save's response was produced.
      mocks.query.data = {
        ...staleResponse,
        max_concurrent_runs: 80,
        concurrency_limit_enabled: false,
      };
      finishRefresh();
      await saving;
    });
    rerender(<FlowConcurrencySettings />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('80');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('retains the draft if refreshing after save fails', async () => {
    render(<FlowConcurrencySettings />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    mocks.refresh.mockRejectedValueOnce(new Error('Refresh failed'));
    await act(async () => {
      await expect(mocks.onSuccess!({})).rejects.toThrow('Refresh failed');
    });
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('100');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('shows a loading status before settings arrive', () => {
    mocks.query.data = undefined;
    mocks.query.isLoading = true;

    render(<FlowConcurrencySettings />);

    expect(screen.getByRole('status').textContent).toContain('Loading Flow limits');
  });

  it('keeps switch focus while a mutation disables only the numeric input', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    const toggle = screen.getByRole('switch', { name: 'Limit parallel Flow runs' });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    toggle.focus();
    mocks.mutation.isPending = true;

    rerender(<FlowConcurrencySettings />);

    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-busy')).toBe('true');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(
      (screen.getByRole('spinbutton', { name: 'Maximum parallel runs' }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(toggle);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('shows the explicit Unlimited state and a mutation failure without changing persisted data', () => {
    mocks.query.data = {
      concurrency_limit_enabled: false,
      max_concurrent_runs: 7,
      occupied_runs: 3,
      queued_runs: 0,
      draining: false,
    };
    mocks.mutation.error = new Error('Could not save settings');

    render(<FlowConcurrencySettings />);

    expect(screen.getByText('3 active · Unlimited')).toBeTruthy();
    expect(
      (screen.getByRole('spinbutton', { name: 'Maximum parallel runs' }) as HTMLInputElement).value,
    ).toBe('7');
    expect(
      screen.getByRole('switch', { name: 'Limit parallel Flow runs' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByRole('alert').textContent).toContain('Could not save settings');
  });

  it('keeps cached controls and focus during polling and configuration refreshes', () => {
    const { rerender } = render(<FlowConcurrencySettings />);
    const toggle = screen.getByRole('switch', { name: 'Limit parallel Flow runs' });
    const maximum = screen.getByRole('spinbutton', { name: 'Maximum parallel runs' });
    toggle.focus();
    fireEvent.change(maximum, { target: { value: '5' } });
    mocks.query.error = new Error('background refresh failed');
    mocks.query.data = {
      concurrency_limit_enabled: true,
      max_concurrent_runs: 6,
      occupied_runs: 4,
      queued_runs: 2,
      draining: true,
    };

    rerender(<FlowConcurrencySettings />);

    expect(screen.getByRole('spinbutton', { name: 'Maximum parallel runs' })).toBeTruthy();
    expect((maximum as HTMLInputElement).value).toBe('5');
    expect(document.activeElement).toBe(toggle);
  });

  it('does not mark a valid numeric value invalid for a save failure', () => {
    mocks.mutation.error = new Error('Could not save settings');
    render(<FlowConcurrencySettings />);

    expect(
      screen
        .getByRole('spinbutton', { name: 'Maximum parallel runs' })
        .getAttribute('aria-invalid'),
    ).toBe('false');
  });

  it('offers a visible retry when settings fail to load', () => {
    mocks.query.data = undefined;
    mocks.query.error = new Error('offline');

    render(<FlowConcurrencySettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not load Flow concurrency settings.',
    );
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
