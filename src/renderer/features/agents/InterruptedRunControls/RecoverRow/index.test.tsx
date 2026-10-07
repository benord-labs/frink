// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../components/ui/tooltip';
import { RecoverRow } from './index';

const renderRow = (overrides: Partial<Parameters<typeof RecoverRow>[0]> = {}) => {
  const props = {
    isRetry: true,
    pending: false,
    confirming: false,
    onTrigger: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(
    <TooltipProvider>
      <RecoverRow {...props} />
    </TooltipProvider>,
  );
  return props;
};

describe('RecoverRow', () => {
  afterEach(cleanup);

  it('labels each recovery mode and its pending state', () => {
    renderRow({ isRetry: false });
    expect(
      screen.getByRole('button', { name: 'Continue the interrupted flow run' }),
    ).toHaveTextContent('Continue');
    cleanup();
    renderRow({ isRetry: true, pending: true });
    expect(screen.getByRole('button', { name: 'Retry the interrupted step' })).toHaveTextContent(
      'Retrying…',
    );
  });

  it('hands focus back to the Retry button when the confirm is cancelled', () => {
    const props = renderRow({ confirming: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Retry the interrupted step' })).toHaveFocus();
  });
});
