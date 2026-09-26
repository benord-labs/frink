// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsTabHeader } from './index';

afterEach(cleanup);

describe('SettingsTabHeader', () => {
  it('renders title and description as h2 + paragraph', () => {
    render(<SettingsTabHeader title="Integrations" description="Connect services" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Integrations' })).toBeDefined();
    expect(screen.getByText('Connect services')).toBeDefined();
  });

  it('renders h1 when titleAs is h1', () => {
    render(<SettingsTabHeader title="Account" titleAs="h1" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeDefined();
  });

  it('omits description when not provided', () => {
    render(<SettingsTabHeader title="Account" titleAs="h1" />);
    expect(screen.queryByRole('paragraph')).toBeNull();
  });

  it('renders actions in the header row', () => {
    render(
      <SettingsTabHeader
        title="Machines"
        description="Devices"
        actions={<button type="button">Refresh</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined();
  });
});
