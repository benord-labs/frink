// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import type {
  SecretMainCheckout,
  SecretRequest,
} from '../../../../../../../shared/types/task-signal';
import { SecretRequestCard } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const REQUEST: SecretRequest = {
  id: 'req-1',
  name: 'STRIPE_KEY',
  chatId: 'chat-1',
  file: '.env',
  cwd: '/repo',
  reason: 'Charge test cards',
  replaces: false,
  git: 'ignored',
};

afterEach(cleanup);

/** What the secretRequests router answers once main has saved and told the agent. */
type RouterAnswer = { ok: true } | null;

function renderCard(
  answer: (op: Operation) => Promise<RouterAnswer>,
  { request = REQUEST }: { request?: SecretRequest } = {},
) {
  const onSettled = vi.fn();
  renderWithTrpc(
    <SecretRequestCard request={request} subChatId="sub-1" taskId="task-1" onSettled={onSettled} />,
    answer,
  );
  return { onSettled };
}

const valueInput = () => screen.getByLabelText('Value for STRIPE_KEY');

describe('SecretRequestCard', () => {
  it('shows the ask in a masked field with an honest promise', () => {
    renderCard(async () => null);

    expect(valueInput()).toHaveAttribute('type', 'password');
    expect(screen.getByText('The agent says: Charge test cards')).toBeInTheDocument();
    expect(screen.getByText(/does not send it to the model/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  const notes: Array<[Partial<SecretRequest>, string]> = [
    [{ replaces: true }, ', replacing the value already there.'],
    [{ git: 'untracked' }, 'Frink will keep this file out of git on this computer.'],
    [{ git: 'tracked' }, 'Git tracks this file, so a commit would include the value.'],
    [
      { mainCheckout: { path: '/main/.env', replaces: false, git: 'ignored' } },
      'in your main project, so later runs have it.',
    ],
    // The exclude list is shared by every checkout, so the main file's change in git is named too.
    [
      { mainCheckout: { path: '/main/.env', replaces: false, git: 'untracked' } },
      'so later runs have it. Frink will keep it out of git on this computer.',
    ],
    [
      { mainCheckout: { skipped: 'Git tracks that file in your main project.' } },
      'Not saved to your main project, so a later run will ask again. Git tracks that file in your main project.',
    ],
  ];

  it.each(notes)('tells the user what saving does (%o)', (overrides, text) => {
    renderCard(async () => null, { request: { ...REQUEST, ...overrides } });

    expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
  });

  it('names both files a worktree chat saves to before Save', () => {
    const mainCheckout: SecretMainCheckout = { path: '/main/.env', replaces: true, git: 'ignored' };
    renderCard(async () => null, { request: { ...REQUEST, mainCheckout } });

    expect(screen.getByText('.env')).toBeInTheDocument();
    expect(screen.getByText('/main/.env')).toBeInTheDocument();
    expect(screen.getByText(/so later runs have it, replacing/)).toBeInTheDocument();
  });

  // Main saves and tells the agent in one step; the card never sends a chat message itself.
  it('hands the value to main and settles once main has answered', async () => {
    const operations: Operation[] = [];
    const { onSettled } = renderCard(async (op) => {
      operations.push(op);
      return { ok: true };
    });

    fireEvent.change(valueInput(), { target: { value: 'sk_live_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(operations.map((op) => [op.path, op.input])).toEqual([
      [
        'secretRequests.submit',
        { subChatId: 'sub-1', requestId: 'req-1', taskId: 'task-1', value: 'sk_live_1' },
      ],
    ]);
    expect(valueInput()).toHaveValue('');
  });

  it('declines through main when the user chooses not to save', async () => {
    const operations: string[] = [];
    const { onSettled } = renderCard(async (op) => {
      operations.push(op.path);
      return { ok: true };
    });

    fireEvent.click(screen.getByRole('button', { name: "Don't save" }));

    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(operations).toEqual(['secretRequests.decline']);
  });

  it('shows why main could not finish and keeps the form usable', async () => {
    const { onSettled } = renderCard(async () => {
      throw new Error('The agent is busy. Try again in a moment.');
    });

    fireEvent.change(valueInput(), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The agent is busy.');
    expect(onSettled).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: "Don't save" })).toBeEnabled();
  });

  it('keeps both buttons locked once the request is answered, so it cannot be answered twice', async () => {
    renderCard(async () => ({ ok: true }));

    fireEvent.click(screen.getByRole('button', { name: "Don't save" }));

    await waitFor(() => expect(screen.getByRole('button', { name: "Don't save" })).toBeDisabled());
    expect(valueInput()).toBeDisabled();
  });

  it('saves once when the form is submitted twice before the first save returns', async () => {
    const operations: string[] = [];
    const { onSettled } = renderCard(async (op) => {
      operations.push(op.path);
      return { ok: true };
    });

    fireEvent.change(valueInput(), { target: { value: 'x' } });
    const form = valueInput().closest('form');
    if (!form) throw new Error('form missing');
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(operations).toEqual(['secretRequests.submit']);
  });
});
