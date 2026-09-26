// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatAtmosphereSurface } from './index';

describe('ChatAtmosphereSurface', () => {
  it('keeps content above a decorative shared atmosphere layer', () => {
    const { container } = render(
      <ChatAtmosphereSurface>
        <p>Settings content</p>
      </ChatAtmosphereSurface>,
    );

    expect(screen.getByText('Settings content')).toBeVisible();
    expect(container.querySelector('.chat-canvas-atmosphere')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});
