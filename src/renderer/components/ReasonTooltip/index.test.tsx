// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '../ui/tooltip';
import { ReasonTooltip } from './index';

function renderReason(props: { summary?: string; details?: string }) {
  return render(
    <TooltipProvider>
      <ReasonTooltip {...props}>
        <span>the line</span>
      </ReasonTooltip>
    </TooltipProvider>,
  );
}

describe('ReasonTooltip', () => {
  it('always renders the line (children)', () => {
    renderReason({ summary: 'Approve plan #143' });
    expect(screen.getByText('the line')).toBeInTheDocument();
  });

  it('wraps the line in a tooltip trigger when summary or details exist', () => {
    renderReason({ summary: 'Approve plan #143' });
    // Radix marks the trigger element with data-state when wrapped in a Tooltip.
    expect(screen.getByText('the line')).toHaveAttribute('data-state');
  });

  it('wraps when only details are present (empty summary)', () => {
    renderReason({ summary: '', details: 'the full context' });
    expect(screen.getByText('the line')).toHaveAttribute('data-state');
  });

  it('renders the line bare (no tooltip) when both summary and details are empty', () => {
    renderReason({ summary: '   ', details: undefined });
    expect(screen.getByText('the line')).not.toHaveAttribute('data-state');
  });
});
