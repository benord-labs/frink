// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsSection } from './SettingsSection';

afterEach(cleanup);

describe('SettingsSection', () => {
  it('labels the section with its title heading', () => {
    render(<SettingsSection title="Test Section">content</SettingsSection>);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Test Section');
    expect(screen.getByRole('region', { name: 'Test Section' })).toBeDefined();
  });

  it('renders children', () => {
    render(
      <SettingsSection title="Title">
        <span data-testid="child">Hello</span>
      </SettingsSection>,
    );
    expect(screen.getByTestId('child').textContent).toBe('Hello');
  });

  it('renders the description only when given', () => {
    const { rerender } = render(<SettingsSection title="Title">body</SettingsSection>);
    expect(screen.queryByText('What this is for')).toBeNull();
    rerender(
      <SettingsSection title="Title" description="What this is for">
        body
      </SettingsSection>,
    );
    expect(screen.getByText('What this is for')).toBeDefined();
  });
});
