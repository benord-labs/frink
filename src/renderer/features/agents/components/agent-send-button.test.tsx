// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
