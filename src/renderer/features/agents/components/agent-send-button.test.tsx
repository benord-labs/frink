// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSendButton } from './agent-send-button';

vi.mock('../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

afterEach(cleanup);

const WARNING = 'Stop — also ends the background work';

// Stopping a turn that adopted a wake hold closes the session, taking its background work with it.
describe('AgentSendButton — Stop on an adopted wake hold', () => {
  it('warns that Stop also ends the background work', () => {
    render(<AgentSendButton isStreaming stopEndsBackgroundWork onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: WARNING })).toBeInTheDocument();
    expect(screen.getByTestId('tooltip-content')).toHaveTextContent(WARNING);
  });

  it('keeps the plain Stop copy for an ordinary streaming turn', () => {
    render(<AgentSendButton isStreaming onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument();
    expect(screen.getByTestId('tooltip-content')).not.toHaveTextContent(WARNING);
  });

  it('shows no warning once the turn is idle', () => {
    render(<AgentSendButton stopEndsBackgroundWork onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
    expect(screen.getByTestId('tooltip-content')).not.toHaveTextContent(WARNING);
  });
});

// The button turns from Send into Stop and back while the pointer rests on it. If a click left
// focus on it, the Enter that takes you back to the message box would press the changed button.
describe('AgentSendButton — focus after a click', () => {
  type ButtonProps = ComponentProps<typeof AgentSendButton>;

  function Composer(props: ButtonProps) {
    return (
      <>
        <textarea aria-label="Message" />
        <AgentSendButton {...props} />
      </>
    );
  }

  it.each([
    {
      change: 'queueing a message turns it into Stop',
      before: { isStreaming: true, hasContent: true },
      clicked: 'Add to queue',
      after: { isStreaming: true },
      clickRuns: 'onClick',
      enterMustNotRun: 'onStop',
    },
    {
      change: 'stopping with messages queued turns it back into Send',
      before: { isStreaming: true },
      clicked: 'Stop generation',
      after: {},
      clickRuns: 'onStop',
      enterMustNotRun: 'onClick',
    },
  ] as const)(
    'keeps focus in the message box when $change, so Enter does not press it',
    async ({ before, clicked, after, clickRuns, enterMustNotRun }) => {
      const user = userEvent.setup();
      const handlers = { onClick: vi.fn(), onStop: vi.fn() };
      const { rerender } = render(<Composer {...before} {...handlers} />);
      const messageBox = screen.getByRole('textbox', { name: 'Message' });

      await user.click(messageBox);
      await user.click(screen.getByRole('button', { name: clicked }));
      expect(handlers[clickRuns]).toHaveBeenCalledOnce();

      rerender(<Composer {...after} {...handlers} />);
      await user.keyboard('{Enter}');

      expect(messageBox).toHaveFocus();
      expect(handlers[enterMustNotRun]).not.toHaveBeenCalled();
    },
  );

  it('still takes focus from Tab, and then Enter presses it', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<Composer isStreaming onClick={vi.fn()} onStop={onStop} />);

    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.tab();
    expect(screen.getByRole('button', { name: 'Stop generation' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onStop).toHaveBeenCalledOnce();
  });
});
