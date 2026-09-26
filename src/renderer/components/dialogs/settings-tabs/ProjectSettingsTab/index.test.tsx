// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Operation } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { ProjectSettingsTab } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

type Account = {
  id: string;
  label: string;
  type: 'claude-code' | 'codex';
  isDefault: boolean;
  isAuthenticated: boolean;
};
type Backend = { accounts: Account[]; projectAccountId: string | null };
/** Every result this page's procedures return in these tests. */
type Answer = Account[] | string | null | { config: null; path: string | null };

const SET_ACCOUNT_INPUT = z.object({ projectId: z.string(), accountId: z.string().nullable() });
const setProjectAccount = vi.fn<(input: z.infer<typeof SET_ACCOUNT_INPUT>) => void>();
const requested = vi.fn<(path: string) => void>();

const backend: Backend = { accounts: [], projectAccountId: null };

const work: Account = {
  id: 'acc-work',
  label: 'Work',
  type: 'claude-code',
  isDefault: true,
  isAuthenticated: true,
};
const workCodex: Account = { ...work, id: 'acc-work-codex', type: 'codex', isDefault: false };

function answer(op: Operation): Promise<Answer> {
  requested(op.path);
  if (op.path === 'claudeCode.listAccounts') return Promise.resolve(backend.accounts);
  if (op.path === 'claudeCode.getProjectAccount') return Promise.resolve(backend.projectAccountId);
  if (op.path === 'claudeCode.setProjectAccount') {
    setProjectAccount(SET_ACCOUNT_INPUT.parse(op.input));
    return Promise.resolve(null);
  }
  if (op.path === 'worktreeConfig.get') return Promise.resolve({ config: null, path: null });
  if (op.path === 'claudeSettings.getWorktreeBasePath') {
    return Promise.resolve({ config: null, path: '/wt' });
  }
  if (op.path === 'external.getHomePath') return Promise.resolve('/Users/benji');
  return Promise.reject(new Error(`Unexpected test operation: ${op.path}`));
}

function renderTab(path: string) {
  return renderWithTrpc(
    <ProjectSettingsTab project={{ id: 'project-1', path }} title="frink" />,
    answer,
  );
}

beforeEach(() => {
  setProjectAccount.mockReset();
  requested.mockReset();
  backend.accounts = [work];
  backend.projectAccountId = null;
});

afterEach(cleanup);

describe('ProjectSettingsTab', () => {
  it('shows worktree setup for a project folder', async () => {
    renderTab('/work/frink');

    expect(screen.getByText('/work/frink')).toBeVisible();
    expect(await screen.findByText('Setup commands')).toBeVisible();
  });

  // Worktrees need a git checkout. Chat folders have no directory and Frink builds have no git,
  // and the router refuses worktree settings for chat folders outright.
  it.each<[string, string]>([
    ['a chat folder', 'virtual://folders/1-inbox'],
    ['a Frink build', '/Users/b/.frink/builds/my-app'],
    ['a Frink build on Windows', 'C:\\Users\\b\\.frink\\builds\\my-app'],
  ])('leaves worktree setup out for %s', async (_kind, path) => {
    renderTab(path);

    expect(await screen.findByText('Account')).toBeVisible();
    expect(screen.queryByText('Worktrees')).toBeNull();
    expect(requested).not.toHaveBeenCalledWith('worktreeConfig.get');
  });

  it('describes a chat folder instead of showing its internal address', () => {
    renderTab('virtual://folders/1-inbox');

    expect(screen.getByText('A folder for organizing chats.')).toBeVisible();
    expect(screen.queryByText(/virtual:\/\//)).toBeNull();
  });
});

describe('ProjectAiAccountSelector', () => {
  it('names the account "Default" stands for', async () => {
    renderTab('/work/frink');

    expect(await screen.findByRole('combobox', { name: 'Account' })).toHaveTextContent(
      'Default (Work)',
    );
  });

  // Two accounts can share a label (one Claude Code, one Codex); only the id tells them apart.
  it('saves the chosen account by id, not by label', async () => {
    const user = userEvent.setup();
    backend.accounts = [work, workCodex];
    renderTab('/work/frink');

    await user.click(await screen.findByRole('combobox', { name: 'Account' }));
    await user.click(await screen.findByRole('option', { name: /Work.*OpenAI/ }));

    await waitFor(() =>
      expect(setProjectAccount).toHaveBeenCalledWith({
        projectId: 'project-1',
        accountId: 'acc-work-codex',
      }),
    );
  });

  it('points to AI providers when there are no accounts yet', async () => {
    backend.accounts = [];
    renderTab('/work/frink');

    expect(
      await screen.findByText('No AI accounts yet. Add one under AI providers.'),
    ).toBeVisible();
  });

  it('warns when the chosen account is not signed in on this computer', async () => {
    backend.accounts = [work, { ...workCodex, label: 'Side', isAuthenticated: false }];
    backend.projectAccountId = 'acc-work-codex';
    renderTab('/work/frink');

    expect(
      await screen.findByText(/isn't signed in on this computer, so chats here won't start/),
    ).toBeVisible();
  });

  it('shows no warning for a signed-in account', async () => {
    backend.projectAccountId = 'acc-work';
    renderTab('/work/frink');

    expect(await screen.findByRole('combobox', { name: 'Account' })).toHaveTextContent('Work');
    expect(screen.queryByText(/isn't signed in/)).toBeNull();
  });
});
