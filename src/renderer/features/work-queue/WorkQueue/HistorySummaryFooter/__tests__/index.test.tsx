// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HistorySummaryFooter } from '..';

describe('HistorySummaryFooter', () => {
  const renderFooter = (completedCount: number, cancelledCount = 0, onViewHistory = vi.fn()) =>
    render(
      <HistorySummaryFooter
        cancelledCount={cancelledCount}
        completedCount={completedCount}
        historyButtonRef={createRef()}
        onViewHistory={onViewHistory}
      />,
    );

  it('stays absent when history is empty', () => {
    const { container } = render(
      <HistorySummaryFooter
        cancelledCount={0}
        completedCount={0}
        historyButtonRef={createRef()}
        onViewHistory={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('summarizes reviewed and cancelled history truthfully', () => {
    const { rerender } = renderFooter(1);
    expect(screen.getByText('1 task reviewed and shipped')).toBeInTheDocument();

    rerender(
      <HistorySummaryFooter
        cancelledCount={2}
        completedCount={6}
        historyButtonRef={createRef()}
        onViewHistory={vi.fn()}
      />,
    );
    expect(screen.getByText('6 tasks reviewed and shipped · 2 cancelled')).toBeInTheDocument();
  });

  it('keeps cancelled-only history visible with neutral copy', () => {
    renderFooter(0, 1);
    expect(screen.getByText('1 cancelled task in history')).toHaveClass('text-muted-foreground');
  });

  it('opens history from the primitive ghost action', () => {
    const onViewHistory = vi.fn();
    renderFooter(3, 0, onViewHistory);

    fireEvent.click(screen.getByRole('button', { name: 'View task history' }));
    expect(onViewHistory).toHaveBeenCalledOnce();
  });
});
