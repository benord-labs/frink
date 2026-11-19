// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunStatusLabel } from '.';

describe('RunStatusLabel', () => {
  it('reads a run held for Start as Ready to start, in the needs-you tone', () => {
    render(<RunStatusLabel status="held" />);

    expect(screen.getByText('Ready to start')).toHaveClass('text-warning');
  });
});
