import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

import { toast } from 'sonner';
import { openActiveFileInEditor } from './open-active-file-in-editor';

describe('openActiveFileInEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls mutate with active file project cwd when present', async () => {
    const mutate = vi.fn().mockResolvedValue({ success: true });
    await openActiveFileInEditor(
      { path: 'src/b.ts', projectPath: '/project' },
      [],
      undefined,
      mutate,
    );
    expect(mutate).toHaveBeenCalledWith({ path: 'src/b.ts', cwd: '/project' });
    expect(toast.info).toHaveBeenCalledWith('Opening b.ts in editor…');
  });

  it('falls back to provided cwd when active file has no projectPath', async () => {
    const mutate = vi.fn().mockResolvedValue({ success: true });
    await openActiveFileInEditor({ path: '/abs/file.ts' }, [], '/project', mutate);
    expect(mutate).toHaveBeenCalledWith({ path: '/abs/file.ts', cwd: '/project' });
  });

  it('falls back to most recently opened file when no active file', async () => {
    const mutate = vi.fn().mockResolvedValue({ success: true });
    await openActiveFileInEditor(null, ['/project/src/recent.ts'], '/project', mutate);
    expect(mutate).toHaveBeenCalledWith({ path: '/project/src/recent.ts', cwd: '/project' });
    expect(toast.info).toHaveBeenCalledWith('Opening recent.ts in editor…');
  });

  it('shows error toast when the editor could not be opened', async () => {
    const mutate = vi.fn().mockResolvedValue({ success: false, error: 'no handler' });
    await openActiveFileInEditor({ path: '/abs/file.ts' }, [], '/project', mutate);
    expect(toast.error).toHaveBeenCalledWith("Couldn't open file.ts in an editor", {
      description: 'no handler',
    });
  });

  it('shows error toast when the mutation rejects (IPC failure)', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('IPC channel closed'));
    await expect(
      openActiveFileInEditor({ path: '/abs/file.ts' }, [], '/project', mutate),
    ).resolves.toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith("Couldn't open file.ts in an editor", {
      description: 'IPC channel closed',
    });
  });

  it('shows info toast when no file available at all', async () => {
    const mutate = vi.fn();
    await openActiveFileInEditor(null, [], '/project', mutate);
    expect(mutate).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith('No file to open — open a file first');
  });
});
