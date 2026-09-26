// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsCard, SettingsCardFooter } from './SettingsCard';

afterEach(cleanup);

describe('SettingsCard', () => {
  it('renders children inside a container', () => {
    render(
      <SettingsCard>
        <span data-testid="content">Card body</span>
      </SettingsCard>,
    );
    expect(screen.getByTestId('content').textContent).toBe('Card body');
  });

  it('applies rounded border styling', () => {
    const { container } = render(<SettingsCard>body</SettingsCard>);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('rounded-xl');
    expect(wrapper.className).toContain('border');
  });
});

describe('SettingsCardFooter', () => {
  it('renders children', () => {
    render(
      <SettingsCardFooter>
        <button type="button" data-testid="btn">
          Save
        </button>
      </SettingsCardFooter>,
    );
    expect(screen.getByTestId('btn').textContent).toBe('Save');
  });

  it('has border-t and flex styling', () => {
    const { container } = render(<SettingsCardFooter>footer</SettingsCardFooter>);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('border-t');
    expect(wrapper.className).toContain('flex');
  });
});
