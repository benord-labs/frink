// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuePausedBanner } from './index';

const mocks = vi.hoisted(() => ({
  paused: true,
  mutation: { isPending: false, mutate: vi.fn() },
}));
vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    flows: {
      getAdmissionSettings: {
        useQuery: () => ({ data: { queue_paused: mocks.paused }, isError: false }),
      },
      updateAdmissionSettings: { useMutation: () => mocks.mutation },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paused = true;
  mocks.mutation.isPending = false;
});
afterEach(cleanup);

describe('QueuePausedBanner', () => {
  it('renders nothing while the queue is running', () => {
    mocks.paused = false;
    const { container } = render(<QueuePausedBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains the pause and resumes from the banner', () => {
    render(<QueuePausedBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Queue paused');
    expect(banner).toHaveTextContent(
      "Queued flows won't start until you resume. Active work keeps running.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
    expect(mocks.mutation.mutate).toHaveBeenCalledWith({ queue_paused: false });
  });

  it('locks Resume while the change is saving', () => {
    mocks.mutation.isPending = true;
    render(<QueuePausedBanner />);
    const resume = screen.getByRole('button', { name: 'Resume queue' });
    expect(resume).toBeDisabled();
    expect(resume).toHaveAttribute('aria-busy', 'true');
  });
});
