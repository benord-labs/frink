// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageGroup } from './MessageGroup';

afterEach(cleanup);

describe('MessageGroup', () => {
  it('gives only the last group a min-height of the viewport less the dock reserve', () => {
    render(
      <>
        <MessageGroup>settled</MessageGroup>
        <MessageGroup isLastGroup>live</MessageGroup>
      </>,
    );
    const settled = screen.getByText('settled');
    const live = screen.getByText('live');
    expect(settled.style.minHeight).toBe('');
    expect(settled).not.toHaveAttribute('data-last-group');
    expect(live.style.minHeight).toBe(
      'calc(var(--chat-container-height) - var(--chat-dock-height) - 1.5rem)',
    );
    expect(live).toHaveAttribute('data-last-group');
  });

  // An inline content-visibility would override the :nth-last-child live-tail exemption.
  it('applies content-visibility through the class, never inline', () => {
    render(<MessageGroup isLastGroup>live</MessageGroup>);
    const group = screen.getByText('live');
    expect(group.style.contentVisibility).toBe('');
    expect(group.className).toContain('nth-last-child(-n+2)');
  });
});
