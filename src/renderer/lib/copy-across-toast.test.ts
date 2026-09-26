import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showCopyResultToast } from './copy-across-toast';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const success = vi.mocked(toast.success);
const error = vi.mocked(toast.error);

afterEach(() => vi.clearAllMocks());

describe('showCopyResultToast', () => {
  it('surfaces a backend error and shows nothing else', () => {
    showCopyResultToast({ copied: [], skipped: [], committedRepo: false, error: 'boom' });
    expect(error).toHaveBeenCalledWith('boom');
    expect(success).not.toHaveBeenCalled();
  });

  it('reports the copied count', () => {
    showCopyResultToast({ copied: ['a', 'b'], skipped: [], committedRepo: false });
    expect(success).toHaveBeenCalledWith('Copied 2 skills');
  });

  it('names a kept hand-edited copy even when nothing new was written (no false success)', () => {
    showCopyResultToast({ copied: [], skipped: ['frontend-design'], committedRepo: false });
    expect(success).toHaveBeenCalledWith('kept your edited copy of frontend-design');
  });

  it('appends the repo-add note for a project target', () => {
    showCopyResultToast({ copied: ['a'], skipped: [], committedRepo: true });
    expect(success).toHaveBeenCalledWith("Copied 1 skill (added to the project's repo)");
  });

  it('falls back to "Nothing to copy" when neither copied nor kept', () => {
    showCopyResultToast({ copied: [], skipped: [], committedRepo: false });
    expect(success).toHaveBeenCalledWith('Nothing to copy');
  });
});
