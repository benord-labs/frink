// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Header } from '.';

const noop = () => undefined;

describe('AgentsMcpTab Header', () => {
  it('swaps the overflow dots for a spinner while servers refresh', () => {
    const { rerender } = render(
      <Header isRefreshing onRefresh={noop} onEditRawConfig={noop} onAddClick={noop} />,
    );
    const trigger = screen.getByRole('button', { name: 'More server options' });
    expect(trigger.querySelector('[data-spinner]')).not.toBeNull();

    rerender(
      <Header isRefreshing={false} onRefresh={noop} onEditRawConfig={noop} onAddClick={noop} />,
    );
    expect(trigger.querySelector('[data-spinner]')).toBeNull();
    expect(trigger.querySelector('svg')).not.toBeNull();
  });
});
