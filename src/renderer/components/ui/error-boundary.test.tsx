// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewerErrorBoundary } from './error-boundary';

afterEach(cleanup);

function ThrowingChild(): ReactElement {
  throw new Error('viewer exploded');
}

function ResetHarness({ onReset }: { onReset: () => void }) {
  const [shouldThrow, setShouldThrow] = useState(true);

  return (
    <ViewerErrorBoundary
      viewerType="markdown"
      onReset={() => {
        setShouldThrow(false);
        onReset();
      }}
    >
      {shouldThrow ? <ThrowingChild /> : <div>Recovered viewer</div>}
    </ViewerErrorBoundary>
  );
}

describe('ViewerErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders fallback when child throws', () => {
    render(
      <ViewerErrorBoundary viewerType="markdown">
        <ThrowingChild />
      </ViewerErrorBoundary>,
    );

    expect(screen.getByText('Failed to render markdown')).toBeTruthy();
    expect(screen.getByText('viewer exploded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('resets error state and calls onReset', () => {
    const onReset = vi.fn();
    render(<ResetHarness onReset={onReset} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Recovered viewer')).toBeTruthy();
  });

  it('renders children when no error occurs', () => {
    render(
      <ViewerErrorBoundary viewerType="code">
        <div>Healthy viewer</div>
      </ViewerErrorBoundary>,
    );

    expect(screen.getByText('Healthy viewer')).toBeTruthy();
  });
});
