// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssigneeSection } from './index';

describe('AssigneeSection', () => {
  it('preserves a saved me condition until the user explicitly changes scope', () => {
    const change = vi.fn();
    render(<AssigneeSection assigneeMode="me" supportsMe={false} onAssigneeModeChange={change} />);
    expect(screen.getByRole('button', { name: 'Me' })).toBeDisabled();
    expect(screen.getByText(/won't run until you choose Anyone/)).toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Anyone' }));
    expect(change).toHaveBeenCalledExactlyOnceWith('anyone');
  });

  it('says why Me is unavailable even once the rule watches anyone', () => {
    render(
      <AssigneeSection assigneeMode="anyone" supportsMe={false} onAssigneeModeChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Me' })).toBeDisabled();
    expect(screen.getByText(/Me isn't available/)).toBeInTheDocument();
  });
});
