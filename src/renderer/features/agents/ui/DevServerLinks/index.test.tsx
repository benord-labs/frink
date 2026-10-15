// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../components/ui/tooltip';
import { DevServerLinks, DevServerLinksView } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

type Link = { port: number; label: string; url: string };

const vite: Link = { port: 5174, label: 'vite', url: 'http://localhost:5174' };
const next: Link = { port: 3000, label: 'next', url: 'http://localhost:3000' };

function renderView(servers: Link[], onOpen = vi.fn()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TooltipProvider>{children}</TooltipProvider>
  );
  const view = render(<DevServerLinksView servers={servers} onOpen={onOpen} />, { wrapper });
  return { ...view, onOpen };
}

afterEach(() => {
  cleanup();
});

describe('DevServerLinks', () => {
  it('renders nothing for a chat without a folder', () => {
    const { container } = render(<DevServerLinks path={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DevServerLinksView', () => {
  it('shows nothing while no server runs', () => {
    const { container } = renderView([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the single running server in the browser', async () => {
    const { onOpen } = renderView([vite]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'vite · localhost:5174' }));
    expect(onOpen).toHaveBeenCalledWith('http://localhost:5174');
  });

  it('lists several servers in a menu', async () => {
    const { onOpen } = renderView([next, vite]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '2 servers' }));
    expect(screen.getByRole('menuitem', { name: 'next · localhost:3000' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'vite · localhost:5174' }));
    expect(onOpen).toHaveBeenCalledWith('http://localhost:5174');
  });

  it('disappears when the server stops', () => {
    const { container, rerender } = renderView([vite]);
    expect(screen.getByRole('button')).toBeInTheDocument();
    rerender(<DevServerLinksView servers={[]} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
