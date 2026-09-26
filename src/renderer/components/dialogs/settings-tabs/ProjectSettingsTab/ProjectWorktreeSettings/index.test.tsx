// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Operation } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { newTestQueryClient, renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { trpc } from '@/lib/trpc';
import { ProjectWorktreeSettings } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

type StoredConfig = { 'setup-worktree'?: string[]; 'worktree-base-path'?: string };
type ConfigAnswer = { config: StoredConfig | null; path: string };
type Backend = {
  stored: StoredConfig;
  /** Pending means "home directory not known yet", where every path verdict is 'unknown'. */
  homeDir: Promise<string>;
  loadConfig: () => Promise<ConfigAnswer>;
  /** Each save waits for this before landing, so a test can hold one in flight. */
  saveGate: Promise<void>;
  saveErrors: Error[];
};

const SAVE_INPUT = z.object({
  projectId: z.string(),
  patch: z.object({
    'setup-worktree': z.array(z.string()).optional(),
    'worktree-base-path': z.string().optional(),
  }),
});
const saveConfig = vi.fn<(input: z.infer<typeof SAVE_INPUT>) => void>();

const backend: Backend = {
  stored: {},
  homeDir: Promise.resolve('/Users/benji'),
  loadConfig: () => Promise.resolve({ config: backend.stored, path: '' }),
  saveGate: Promise.resolve(),
  saveErrors: [],
};

/** Merges a save into the stored file the way the main-process router does. */
async function applySave(input: z.infer<typeof SAVE_INPUT>): Promise<null> {
  await backend.saveGate;
  const error = backend.saveErrors.shift();
  if (error) throw error;
  backend.stored = { ...backend.stored, ...input.patch };
  return null;
}

/** Answers the worktree procedures in-process, the way the main-process routers would. */
function answer(op: Operation): Promise<ConfigAnswer | string | null> {
  if (op.path === 'worktreeConfig.get') return backend.loadConfig();
  if (op.path === 'external.getHomePath') return backend.homeDir;
  if (op.path === 'claudeSettings.getWorktreeBasePath') {
    return Promise.resolve({ config: null, path: '/Users/benji/.frink/worktrees' });
  }
  if (op.path === 'worktreeConfig.save') {
    const input = SAVE_INPUT.parse(op.input);
    saveConfig(input);
    return applySave(input);
  }
  return Promise.reject(new Error(`Unexpected test operation: ${op.path}`));
}

function renderSettings(queryClient = newTestQueryClient(), projectId = 'project-1') {
  return renderWithTrpc(<ProjectWorktreeSettings projectId={projectId} />, answer, queryClient);
}

const newRow = () => screen.getByRole('textbox', { name: 'New command' });
const commandRows = () =>
  screen.queryAllByRole<HTMLTextAreaElement>('textbox', { name: /^Command \d+$/ });
const commandValues = () => commandRows().map((row) => row.value);
const location = () => screen.getByLabelText<HTMLInputElement>('Location');
const loaded = () => waitFor(() => expect(newRow()).toBeEnabled());
const lastSave = () => saveConfig.mock.lastCall?.[0];

beforeEach(() => {
  saveConfig.mockReset();
  backend.stored = {};
  backend.homeDir = Promise.resolve('/Users/benji');
  backend.loadConfig = () => Promise.resolve({ config: backend.stored, path: '' });
  backend.saveGate = Promise.resolve();
  backend.saveErrors = [];
});

afterEach(cleanup);

describe('ProjectWorktreeSettings', () => {
  it('shows each stored command in its own row', async () => {
    backend.stored = { 'setup-worktree': ['bun install', 'cp $ROOT_WORKTREE_PATH/.env .env'] };
    renderSettings();
    await loaded();

    expect(commandValues()).toEqual(['bun install', 'cp $ROOT_WORKTREE_PATH/.env .env']);
  });

  it('adds a command by typing in the empty last row, saving when it loses focus', async () => {
    const user = userEvent.setup();
    renderSettings();
    await loaded();

    const input = newRow();
    await user.type(input, 'bun');
    // The row turns into a command while typing, so it must keep focus rather than remount.
    expect(input).toHaveFocus();
    await user.type(input, ' install');
    fireEvent.blur(input);

    expect(commandValues()).toEqual(['bun install']);
    expect(newRow()).toHaveValue('');
    await waitFor(() =>
      expect(lastSave()).toEqual({
        projectId: 'project-1',
        patch: { 'setup-worktree': ['bun install'] },
      }),
    );
  });

  it('saves on Enter without adding a line, and Shift+Enter adds a line', async () => {
    const user = userEvent.setup();
    renderSettings();
    await loaded();

    await user.type(newRow(), 'npm ci{Shift>}{Enter}{/Shift}npm run build{Enter}');

    expect(commandValues()).toEqual(['npm ci\nnpm run build']);
    await waitFor(() =>
      expect(lastSave()?.patch).toEqual({ 'setup-worktree': ['npm ci\nnpm run build'] }),
    );
  });

  // Each row runs as one shell command, so a multi-line row is a small script and must survive
  // editing instead of being flattened into one broken line.
  it('keeps the line breaks of a multi-line command while it is edited', async () => {
    const user = userEvent.setup();
    backend.stored = { 'setup-worktree': ['npm ci\nnpm run build'] };
    renderSettings();
    await loaded();

    const [row] = commandRows();
    await user.type(row, ' --silent');
    fireEvent.blur(row);

    await waitFor(() =>
      expect(lastSave()?.patch).toEqual({
        'setup-worktree': ['npm ci\nnpm run build --silent'],
      }),
    );
  });

  // A snippet pasted from a README must not be flattened into `bun install cp …`, which bun would
  // read as packages to add. (Chromium's textarea already normalizes pasted CRLF to LF.)
  it('keeps a pasted multi-line snippet as one command with its line breaks', async () => {
    const user = userEvent.setup();
    renderSettings();
    await loaded();

    await user.click(newRow());
    await user.paste('bun install\ncp $ROOT_WORKTREE_PATH/.env .env');
    fireEvent.blur(commandRows()[0]);

    await waitFor(() =>
      expect(lastSave()?.patch).toEqual({
        'setup-worktree': ['bun install\ncp $ROOT_WORKTREE_PATH/.env .env'],
      }),
    );
  });

  it('saves straight away when a command is removed', async () => {
    const user = userEvent.setup();
    backend.stored = { 'setup-worktree': ['bun install', 'bun run build'] };
    renderSettings();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Remove command 1' }));

    expect(commandValues()).toEqual(['bun run build']);
    await waitFor(() => expect(lastSave()?.patch).toEqual({ 'setup-worktree': ['bun run build'] }));
  });

  // A focus change with no edit must never rewrite a file that is often checked into the repo.
  it('does not save when nothing changed, and saves an edit only once', async () => {
    const user = userEvent.setup();
    backend.stored = { 'setup-worktree': ['bun install'] };
    renderSettings();
    await loaded();

    const input = newRow();
    fireEvent.blur(input);
    await user.type(input, 'bun run build');
    fireEvent.blur(input);
    fireEvent.blur(input);

    await waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
  });

  // The file can change under the open page (an agent, a git pull), so a save carries only the
  // field the user edited; the router merges it into whatever the file holds now.
  it('sends only the field that changed', async () => {
    const user = userEvent.setup();
    backend.stored = { 'setup-worktree': ['bun install'], 'worktree-base-path': '/tmp/old' };
    renderSettings();
    await loaded();

    await user.clear(location());
    await user.type(location(), '~/code/worktrees{Enter}');

    await waitFor(() =>
      expect(lastSave()).toEqual({
        projectId: 'project-1',
        patch: { 'worktree-base-path': '~/code/worktrees' },
      }),
    );
  });

  it('says a save failed until one succeeds, retrying on each blur', async () => {
    const user = userEvent.setup();
    backend.saveErrors = [new Error('disk full'), new Error('disk full')];
    renderSettings();
    await loaded();

    const input = newRow();
    await user.type(input, 'a');
    fireEvent.blur(input);
    await waitFor(() =>
      expect(toast.getHistory()).toContainEqual(
        expect.objectContaining({ title: "Couldn't save worktree settings: disk full" }),
      ),
    );
    expect(await screen.findByText("Couldn't save your last change.")).toBeVisible();

    await user.type(newRow(), 'b');
    fireEvent.blur(commandRows()[1]);
    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(2));

    // Both saves failed, so undoing the second edit still differs from the file and must be sent.
    await user.click(screen.getByRole('button', { name: 'Remove command 2' }));
    await waitFor(() => expect(lastSave()?.patch).toEqual({ 'setup-worktree': ['a'] }));
    expect(
      await screen.findByText(
        'Changes save automatically to .frink/worktrees.json in this project.',
      ),
    ).toBeVisible();
  });

  // Closing Settings from the keyboard unmounts the page while a field still has focus.
  it('saves unsaved edits when the page unmounts', async () => {
    const { unmount } = renderSettings();
    await loaded();

    fireEvent.change(newRow(), { target: { value: 'bun install' } });
    unmount();

    await waitFor(() =>
      expect(lastSave()).toEqual({
        projectId: 'project-1',
        patch: { 'setup-worktree': ['bun install'] },
      }),
    );
  });

  // Reopening the project while its save-on-close is still in flight would otherwise load the
  // file from before that save and write over it on the next edit.
  it('waits for an in-flight save before loading the form again', async () => {
    const queryClient = newTestQueryClient();
    let landSave = () => {};
    backend.saveGate = new Promise((resolve) => {
      landSave = resolve;
    });
    const first = renderSettings(queryClient);
    await loaded();
    fireEvent.change(newRow(), { target: { value: 'bun install' } });
    first.unmount();

    renderSettings(queryClient);
    await waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
    expect(newRow()).toBeDisabled();

    landSave();
    await loaded();
    expect(commandValues()).toEqual(['bun install']);
  });

  it("doesn't wait for another project's save before loading", async () => {
    const queryClient = newTestQueryClient();
    backend.saveGate = new Promise(() => {});
    const other = renderSettings(queryClient, 'project-2');
    await loaded();
    fireEvent.change(newRow(), { target: { value: 'bun install' } });
    other.unmount();
    await waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());

    renderSettings(queryClient);

    await loaded();
  });

  // A later save for the other field can succeed after an earlier one failed; without a resend
  // the status would read as saved while the failed edit never reached the file.
  it('resends everything once a save succeeds after an earlier one failed', async () => {
    const user = userEvent.setup();
    let release = () => {};
    backend.saveGate = new Promise((resolve) => {
      release = resolve;
    });
    backend.saveErrors = [new Error('disk full')];
    renderSettings();
    await loaded();

    const input = newRow();
    await user.type(input, 'bun install');
    fireEvent.blur(input);
    await user.type(location(), '~/code/worktrees{Enter}');
    release();

    await waitFor(() =>
      expect(lastSave()?.patch).toEqual({
        'setup-worktree': ['bun install'],
        'worktree-base-path': '~/code/worktrees',
      }),
    );
    expect(saveConfig).toHaveBeenCalledTimes(3);
    expect(
      await screen.findByText(
        'Changes save automatically to .frink/worktrees.json in this project.',
      ),
    ).toBeVisible();
  });

  // Seeding from a cached copy would let the first autosave write stale commands over newer ones
  // (for example, ones an agent just wrote).
  it('waits for a fresh fetch instead of showing a cached copy', async () => {
    const queryClient = newTestQueryClient();
    const queryKey = getQueryKey(trpc.worktreeConfig.get, { projectId: 'project-1' }, 'query');
    queryClient.setQueryData(queryKey, { config: { 'setup-worktree': ['stale'] }, path: '' });
    let release = () => {};
    backend.stored = { 'setup-worktree': ['fresh'] };
    backend.loadConfig = () =>
      new Promise((resolve) => {
        release = () => resolve({ config: backend.stored, path: '' });
      });
    renderSettings(queryClient);

    expect(commandRows()).toHaveLength(0);
    expect(newRow()).toBeDisabled();

    release();
    await loaded();
    expect(commandValues()).toEqual(['fresh']);
  });

  it('stays read-only when the fresh fetch fails, even with a cached copy', async () => {
    const queryClient = newTestQueryClient();
    const queryKey = getQueryKey(trpc.worktreeConfig.get, { projectId: 'project-1' }, 'query');
    queryClient.setQueryData(queryKey, { config: { 'setup-worktree': ['stale'] }, path: '' });
    backend.loadConfig = () => Promise.reject(new Error('Project not found'));
    renderSettings(queryClient);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load this project's worktree settings: Project not found",
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(commandRows()).toHaveLength(0);
    expect(newRow()).toBeDisabled();
  });

  it('holds back a location error while typing, showing it once the field loses focus', async () => {
    const user = userEvent.setup();
    renderSettings();
    await loaded();

    await user.type(location(), 'relative/path');
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.blur(location());
    expect(screen.getByRole('alert')).toHaveTextContent('Path must be an absolute path.');

    // Retyping passes through partial paths like `~`, which are refused on their own.
    await user.clear(location());
    await user.type(location(), '~');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  // These are the paths the field used to accept and the backend then refused, leaving the user
  // with a green field and a failed save.
  it.each<[string, string]>([
    ['~/projects/../.ssh', 'a traversal reaching a home secret'],
    ['/tmp/../etc', 'a traversal reaching a system directory'],
    ['C:/worktrees', 'a Windows drive path, which is relative on this platform'],
  ])('refuses %s before submitting (%s)', async (badPath) => {
    const user = userEvent.setup();
    renderSettings();
    await loaded();

    await user.type(location(), badPath);
    fireEvent.blur(location());

    expect(screen.getByRole('alert')).toBeVisible();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  // Both fields live in one file, so a bad location must not swallow a command edit.
  it('still saves command edits while the location is invalid', async () => {
    const user = userEvent.setup();
    backend.stored = { 'worktree-base-path': '~/code/worktrees' };
    renderSettings();
    await loaded();

    await user.clear(location());
    await user.type(location(), 'relative/path');
    const input = newRow();
    await user.type(input, 'bun install');
    fireEvent.blur(input);

    await waitFor(() =>
      expect(lastSave()).toEqual({
        projectId: 'project-1',
        patch: { 'setup-worktree': ['bun install'] },
      }),
    );
  });

  // Claiming a path is valid before the home directory is known is what let secret directories
  // through on first render. Staying quiet defers to the router, which is the authority.
  it('leaves a path it cannot judge yet to the router while the home directory is unknown', async () => {
    const user = userEvent.setup();
    backend.homeDir = new Promise(() => {});
    renderSettings();
    await loaded();

    await user.type(location(), '/Users/benji/.aws');
    fireEvent.blur(location());

    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() =>
      expect(lastSave()?.patch).toEqual({ 'worktree-base-path': '/Users/benji/.aws' }),
    );
  });

  // The config file is hand-editable, so the form can be seeded with a path the backend would
  // refuse. The refusal has to surface on mount, not only after the user touches the field.
  it('flags a stored location the backend would refuse, without waiting for a blur', async () => {
    backend.stored = { 'worktree-base-path': '~/.ssh' };
    renderSettings();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please choose a more specific directory for worktrees.',
    );
  });

  // Clearing the field with the spacebar has to mean "use the default", not "save a blank
  // location" — the router drops the key for an empty value.
  it('clears the location when the field holds only whitespace', async () => {
    const user = userEvent.setup();
    backend.stored = { 'worktree-base-path': '~/code/worktrees' };
    renderSettings();
    await loaded();

    await user.clear(location());
    await user.type(location(), '   ');
    fireEvent.blur(location());

    await waitFor(() => expect(lastSave()?.patch).toEqual({ 'worktree-base-path': '' }));
  });

  // Enter also confirms an IME composition (e.g. Japanese input); that must not commit the field.
  it('ignores Enter while an input method is composing', async () => {
    renderSettings();
    await loaded();

    fireEvent.change(location(), { target: { value: 'relative/path' } });
    fireEvent.keyDown(location(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(newRow(), { key: 'Enter', isComposing: true });

    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.keyDown(location(), { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Path must be an absolute path.');
  });

  it('shows the default location as the placeholder', async () => {
    renderSettings();
    await loaded();

    await waitFor(() =>
      expect(location()).toHaveAttribute('placeholder', '/Users/benji/.frink/worktrees'),
    );
  });
});
