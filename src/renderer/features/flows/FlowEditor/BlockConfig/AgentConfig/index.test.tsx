// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { AgentConfig } from '.';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

afterEach(cleanup);

const PLAN_UNAVAILABLE = "Plan mode isn't available for OpenAI yet. Pick another mode.";
const DEBUG_UNAVAILABLE = "Debug mode isn't available for OpenAI yet. Pick another mode.";
const DEBUG_NOTES = /Debug mode runs an interactive hypothesis-driven session/;

function renderAgentStep(accountType: string, mode?: string): void {
  renderWithTrpc(
    <AgentConfig
      node={{ id: 'agent-1', blockType: 'agent', config: { instructions: 'Fix the bug', mode } }}
      flowSettings={{ defaultProjectId: 'project-1' }}
      onConfigPatch={() => {}}
    />,
    ({ path }) =>
      path === 'claudeCode.getResolvedAccount'
        ? Promise.resolve({ type: accountType, label: 'Account', isAuthenticated: true })
        : new Promise(() => {}),
  );
}

function openModeMenu(): void {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Mode' }), { key: 'Enter' });
}

describe('AgentConfig mode on an OpenAI project', () => {
  it('leaves Plan off the menu once the project resolves', async () => {
    renderAgentStep('codex');
    openModeMenu();
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Plan' })).toBeNull());
    expect(screen.getByRole('option', { name: 'Agent (execute)' })).toBeInTheDocument();
  });

  it('says why a step saved as Plan will not run, without the auto-approve box', async () => {
    renderAgentStep('codex', 'plan');
    expect(await screen.findByText(PLAN_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByLabelText('Auto-approve the plan')).toBeNull();
  });

  it('leaves Debug off the menu once an OpenAI project resolves', async () => {
    renderAgentStep('codex');
    openModeMenu();
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Debug' })).toBeNull());
    expect(screen.getByRole('option', { name: 'Agent (execute)' })).toBeInTheDocument();
  });

  it('says why a step saved as Debug will not run, without the debug notes', async () => {
    renderAgentStep('codex', 'debug');
    expect(await screen.findByText(DEBUG_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText(DEBUG_NOTES)).toBeNull();
  });
});

describe('AgentConfig mode on a Claude project', () => {
  it('offers Plan, Debug and the auto-approve box', async () => {
    renderAgentStep('claude-code', 'plan');
    expect(screen.getByLabelText('Auto-approve the plan')).toBeInTheDocument();
    openModeMenu();
    expect(await screen.findByRole('option', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Debug' })).toBeInTheDocument();
    expect(screen.queryByText(PLAN_UNAVAILABLE)).toBeNull();
  });

  it('keeps the debug notes on a step saved as Debug', async () => {
    renderAgentStep('claude-code', 'debug');
    await waitFor(() => expect(screen.getByText(DEBUG_NOTES)).toBeInTheDocument());
    expect(screen.queryByText(DEBUG_UNAVAILABLE)).toBeNull();
  });
});
