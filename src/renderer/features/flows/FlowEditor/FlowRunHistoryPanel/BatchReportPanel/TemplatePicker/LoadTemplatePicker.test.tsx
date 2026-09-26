// @vitest-environment happy-dom
/**
 * LoadTemplatePicker — medium-severity: clipboard API can reject; user must see feedback.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadTemplatePicker } from './LoadTemplatePicker';

const tplSnap = vi.hoisted(() => ({
  data: [] as Array<{ id: string; name: string; stages: unknown[] }>,
  isLoading: false,
  isError: false,
}));

vi.mock('../../../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      listBatchPlanTemplates: {
        useQuery: () => ({
          data: tplSnap.data,
          isLoading: tplSnap.isLoading,
          isError: tplSnap.isError,
        }),
      },
    },
  },
}));

vi.mock('../../../../../../components/ui/popover', () => {
  /** Props we merge onto the trigger child (typically a `<button>`). */
  type PopoverTriggerChildProps = {
    onClick?: (e: React.MouseEvent) => void;
  };

  const Popover = ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
  }) => {
    const ch = React.Children.toArray(children);
    const trigger = ch[0];
    const content = ch[1];
    return (
      <div data-testid="popover-root" data-open={String(!!open)}>
        {React.isValidElement(trigger)
          ? React.cloneElement(trigger as React.ReactElement<{ onPopoverOpen?: () => void }>, {
              onPopoverOpen: () => onOpenChange?.(true),
            })
          : trigger}
        {open ? content : null}
      </div>
    );
  };

  const PopoverTrigger = ({
    children,
    onPopoverOpen,
  }: {
    children: React.ReactElement<PopoverTriggerChildProps>;
    onPopoverOpen?: () => void;
  }) =>
    React.cloneElement<PopoverTriggerChildProps>(children, {
      onClick: (e: React.MouseEvent) => {
        children.props.onClick?.(e);
        onPopoverOpen?.();
      },
    });

  const PopoverContent = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  );

  return { Popover, PopoverTrigger, PopoverContent };
});

afterEach(() => {
  cleanup();
  tplSnap.data = [];
  tplSnap.isLoading = false;
  tplSnap.isError = false;
  vi.restoreAllMocks();
});

describe('LoadTemplatePicker', () => {
  it('shows an alert when clipboard.writeText rejects', async () => {
    const user = userEvent.setup();
    tplSnap.data = [
      {
        id: 'tpl-1',
        name: 'My template',
        stages: [{ stageNumber: 1, name: 'A', dependsOn: [] }],
      },
    ];

    const spy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

    render(<LoadTemplatePicker flowId="flow-id" />);

    await user.click(screen.getByLabelText('Load template'));

    await waitFor(() => {
      expect(screen.getByText('My template')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /My template/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't copy to clipboard");
    });

    spy.mockRestore();
  });
});
