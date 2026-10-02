// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuePauseControl } from './index';

const mocks = vi.hoisted(() => ({
  query: {
    data: { queue_paused: false } as { queue_paused: boolean } | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  mutation: { isPending: false, mutate: vi.fn() },
  options: {} as {
    onSuccess: (data: { queue_paused: boolean }) => void;
    onError: (error: Error) => void;
  },
  setData: vi.fn(),
  invalidate: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      flows: {
        getAdmissionSettings: { setData: mocks.setData, invalidate: mocks.invalidate },
        workQueueAdmissions: { invalidate: mocks.invalidate },
      },
      tasks: { workQueueOverviewCounts: { invalidate: mocks.invalidate } },
    }),
    flows: {
      getAdmissionSettings: { useQuery: () => mocks.query },
      updateAdmissionSettings: {
        useMutation: (options: typeof mocks.options) => {
          mocks.options = options;
          return mocks.mutation;
        },
      },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.data = { queue_paused: false };
  mocks.query.isLoading = false;
  mocks.query.isError = false;
  mocks.mutation.isPending = false;
});
afterEach(cleanup);

describe('QueuePauseControl', () => {
  it('requests a pause, then hands the paused state to the Overview banner', () => {
    const view = render(<QueuePauseControl />);
    const pause = screen.getByRole('button', { name: 'Pause queue' });
    expect(pause).toHaveAccessibleDescription(/Active work continues/);
    fireEvent.click(pause);
    expect(mocks.mutation.mutate).toHaveBeenCalledWith({ queue_paused: true });
    mocks.options.onSuccess({ queue_paused: true });
    expect(mocks.setData).toHaveBeenCalledWith(undefined, { queue_paused: true });
    expect(mocks.invalidate).toHaveBeenCalled();
    mocks.query.data = { queue_paused: true };
    view.rerender(<QueuePauseControl />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('disables submission while loading or saving', () => {
    mocks.query.data = undefined;
    mocks.query.isLoading = true;
    const view = render(<QueuePauseControl />);
    expect(screen.getByRole('button', { name: 'Pause queue' })).toBeDisabled();
    mocks.query.data = { queue_paused: false };
    mocks.query.isLoading = false;
    mocks.mutation.isPending = true;
    view.rerender(<QueuePauseControl />);
    const pause = screen.getByRole('button', { name: 'Pause queue' });
    expect(pause).toBeDisabled();
    expect(pause).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(pause);
    expect(mocks.mutation.mutate).not.toHaveBeenCalled();
  });

  it('offers retry if settings cannot be loaded', () => {
    mocks.query.data = undefined;
    mocks.query.isError = true;
    render(<QueuePauseControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry queue controls' }));
    expect(mocks.query.refetch).toHaveBeenCalledOnce();
    expect(mocks.mutation.mutate).not.toHaveBeenCalled();
  });

  it('reports a failed pause without changing displayed state', () => {
    render(<QueuePauseControl />);
    mocks.options.onError(new Error('Could not save settings'));
    expect(mocks.toastError).toHaveBeenCalledWith('Could not change queue execution', {
      description: 'Could not save settings',
    });
    expect(screen.getByRole('button', { name: 'Pause queue' })).toBeEnabled();
    expect(mocks.setData).not.toHaveBeenCalled();
  });
});
