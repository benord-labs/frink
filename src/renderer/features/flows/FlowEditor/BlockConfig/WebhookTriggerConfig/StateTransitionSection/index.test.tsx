// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StateTransitionSection } from './index';

describe('StateTransitionSection', () => {
  it('accepts exact custom workflow state names without a token lookup', () => {
    const change = vi.fn();
    render(
      <StateTransitionSection
        fromStatus=""
        toStatus="Ready for QA"
        onFromStatusChange={vi.fn()}
        onToStatusChange={change}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'From workflow state name' })).toHaveValue('');
    const destination = screen.getByRole('textbox', { name: 'To workflow state name' });
    expect(destination).toHaveValue('Ready for QA');
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(destination, { target: { value: 'Done reviewing' } });
    expect(change).toHaveBeenCalledExactlyOnceWith('Done reviewing');
  });
});
