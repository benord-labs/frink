// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyPanePlaceholder } from './index';

afterEach(cleanup);

describe('EmptyPanePlaceholder', () => {
  it('lets the prompt wrap inside a narrow pane instead of forcing a fixed line break', () => {
    render(<EmptyPanePlaceholder paneIndex={0} />);

    const prompt = screen.getByText('Select a chat from the sidebar or start a new one');
    expect(prompt.querySelector('br')).toBeNull();
    expect(prompt).toHaveProperty('className', expect.stringContaining('text-balance'));
    expect(prompt.parentElement?.className).toContain('px-4');
  });
});
