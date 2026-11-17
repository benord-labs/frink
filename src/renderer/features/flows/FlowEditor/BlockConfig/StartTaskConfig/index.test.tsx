// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { StartTaskConfig } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

const PLAN_UNAVAILABLE = "Plan mode isn't available for OpenAI yet. Pick another mode.";

function renderStartTask(accountType: string, startMode?: string): void {
  renderWithTrpc(
    <TooltipProvider>
      <StartTaskConfig
        node={{
          id: 'start-1',
          blockType: 'start_task',
          config: { projectId: 'project-1', startMode },
        }}
        onPatchLabel={() => {}}
        onConfigPatch={() => {}}
      />
    </TooltipProvider>,
    ({ path }) =>
      path === 'claudeCode.getResolvedAccount'
        ? Promise.resolve({ type: accountType, label: 'Account', isAuthenticated: true })
        : new Promise(() => {}),
  );
}

function openStartModeMenu(): void {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Start mode' }), { key: 'Enter' });
}

describe('StartTaskConfig start mode', () => {
  it('leaves Plan off the menu on an OpenAI project', async () => {
    renderStartTask('codex');
    openStartModeMenu();
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Plan' })).toBeNull());
    expect(screen.getByRole('option', { name: 'Execute' })).toBeInTheDocument();
  });

  it('says why a task saved to start in Plan will not run on an OpenAI project', async () => {
    renderStartTask('codex', 'plan');
    expect(await screen.findByText(PLAN_UNAVAILABLE)).toBeInTheDocument();
  });

  it('offers Plan on a Claude project', async () => {
    renderStartTask('claude-code', 'plan');
    openStartModeMenu();
    expect(await screen.findByRole('option', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.queryByText(PLAN_UNAVAILABLE)).toBeNull();
  });
});
