// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunStatusRow } from './index';

describe('RunStatusRow', () => {
  it('keeps the state, sheds the detail first and then the action labels, on its own width', () => {
    render(
      <RunStatusRow dotClassName="bg-primary" label="Ready for review" detail="verify it.">
        <button type="button" aria-label="Mark task complete">
          <svg aria-hidden />
          <span>Mark complete</span>
        </button>
      </RunStatusRow>,
    );

    expect(screen.getByText('Ready for review')).toBeInTheDocument();
    expect(screen.getByText(/verify it\./)).toHaveClass('@max-[40rem]/run-status:hidden');
    // Below the icon tier each action is a 28px icon square that keeps its accessible name.
    const actions = screen.getByRole('button', { name: 'Mark task complete' }).parentElement;
    expect(actions).toHaveClass(
      '@max-[26rem]/run-status:[&_button>span]:hidden',
      '@max-[26rem]/run-status:[&_button]:w-7',
    );
  });

  it('renders no detail separator when there is no detail', () => {
    render(
      <RunStatusRow dotClassName="bg-primary" label="Task failed">
        <span />
      </RunStatusRow>,
    );

    expect(screen.getByRole('status')).toHaveTextContent(/^Task failed$/);
  });
});
