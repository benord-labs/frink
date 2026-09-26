// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowConcurrencySettings } from './index';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
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
    flows: {
      getAdmissionSettings: {
        useQuery: () => ({ ...mocks.query, refetch: mocks.refetch }),
      },
      updateAdmissionSettings: {
        useMutation: () => ({ ...mocks.mutation, mutate: mocks.mutate }),
      },
    },
  },
}));

describe('FlowConcurrencySettings', () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.refetch.mockClear();
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

  it('labels both controls and submits only validated settings', () => {
    render(<FlowConcurrencySettings />);

    expect(screen.getByText('4 / 4 · draining · 2 queued')).toBeTruthy();
    expect(screen.getByText(/Paused Flows and questions keep their slot/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Limit parallel Flow runs' }));
    expect(mocks.mutate).toHaveBeenCalledWith({ concurrency_limit_enabled: false });

    const maximum = screen.getByRole('spinbutton', { name: 'Maximum parallel runs' });
    fireEvent.change(maximum, { target: { value: '6' } });
    fireEvent.blur(maximum);
    expect(mocks.mutate).toHaveBeenCalledWith({ max_concurrent_runs: 6 });

    fireEvent.change(maximum, { target: { value: '21' } });
    fireEvent.blur(maximum);
    expect(screen.getByRole('alert').textContent).toContain('Enter a whole number from 1 to 20.');
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

    expect(screen.getByText('Unlimited')).toBeTruthy();
    expect(screen.getByText('3 active · Unlimited')).toBeTruthy();
    expect(screen.getByText('Maximum parallel runs').tagName).toBe('P');
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
