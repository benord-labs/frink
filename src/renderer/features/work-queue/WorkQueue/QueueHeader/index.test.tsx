// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueHeader } from './index';

afterEach(cleanup);

function renderQueueHeader(overrides: Partial<Parameters<typeof QueueHeader>[0]> = {}) {
  return render(
    <QueueHeader
      headingRef={createRef<HTMLHeadingElement>()}
      isLoading={false}
      openTaskCount={3}
      backToOverviewButtonRef={createRef<HTMLButtonElement>()}
      canDeleteAll={false}
      isDeletingAll={false}
      isHistoryView={false}
      isMutating={false}
      onClose={vi.fn()}
      onDeleteAll={vi.fn()}
      onReturnToOverview={vi.fn()}
      {...overrides}
    />,
  );
}

describe('QueueHeader', () => {
  it('renders the title and open task count', () => {
    renderQueueHeader({ openTaskCount: 5 });
    expect(screen.getByRole('heading', { name: 'Work Queue' })).toBeInTheDocument();
    expect(screen.getByLabelText('5 open tasks')).toHaveTextContent('5');
  });

  it('hides the task count badge while loading', () => {
    renderQueueHeader({ isLoading: true, openTaskCount: 5 });
    expect(screen.queryByLabelText('5 open tasks')).toBeNull();
  });

  it('renders the sidebar trigger ahead of the title when provided', () => {
    renderQueueHeader({ sidebarTrigger: <div data-testid="sidebar-trigger-stub" /> });
    expect(screen.getByTestId('sidebar-trigger-stub')).toBeInTheDocument();
  });

  it('renders nothing extra when no sidebar trigger is provided', () => {
    renderQueueHeader();
    expect(screen.queryByTestId('sidebar-trigger-stub')).toBeNull();
  });

  it('always renders the close action', () => {
    renderQueueHeader();
    expect(screen.getByRole('button', { name: 'Close Work Queue' })).toBeInTheDocument();
  });
});
