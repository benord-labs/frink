// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PendingChatPlaceholder } from '.';

describe('PendingChatPlaceholder', () => {
  it('shows the sent message with a spinner while the chat is created', () => {
    const { container } = render(<PendingChatPlaceholder text="Fix the login bug" />);
    expect(screen.getByText('Fix the login bug')).toBeDefined();
    const status = screen.getByText('Creating chat…').parentElement;
    expect(status?.querySelector('[data-spinner]')).not.toBeNull();
    expect(container.querySelectorAll('[data-spinner]')).toHaveLength(1);
  });
});
