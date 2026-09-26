import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCopyExternalFilesHandlers } from './file-mutation-handlers';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const success = vi.mocked(toast.success);
const warning = vi.mocked(toast.warning);
const error = vi.mocked(toast.error);

afterEach(() => vi.clearAllMocks());

function result(
  over: Partial<Parameters<ReturnType<typeof createCopyExternalFilesHandlers>['onSuccess']>[0]>,
) {
  return { copied: 0, skipped: 0, renamed: 0, errors: [], ...over };
}

describe('createCopyExternalFilesHandlers', () => {
  it('invalidates the tree and surfaces a plain success when nothing was renamed', () => {
    const invalidate = vi.fn();
    createCopyExternalFilesHandlers(invalidate).onSuccess(result({ copied: 3 }));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledWith('Added 3 item(s)');
  });

  it('names the renamed count so the keepBoth default is never silent', () => {
    createCopyExternalFilesHandlers(vi.fn()).onSuccess(result({ copied: 3, renamed: 1 }));
    expect(success).toHaveBeenCalledWith('Added 3 item(s) (1 renamed to avoid overwriting)');
  });

  it('pairs the success toast with a warning when some items failed', () => {
    createCopyExternalFilesHandlers(vi.fn()).onSuccess(
      result({ copied: 2, errors: [{ path: '/x', message: 'boom' }] }),
    );
    expect(success).toHaveBeenCalledWith('Added 2 item(s)');
    expect(warning).toHaveBeenCalledWith('1 item(s) could not be added');
  });

  it('shows the first error message when nothing was added', () => {
    createCopyExternalFilesHandlers(vi.fn()).onSuccess(
      result({ copied: 0, errors: [{ path: '/x', message: 'permission denied' }] }),
    );
    expect(error).toHaveBeenCalledWith('permission denied');
    expect(success).not.toHaveBeenCalled();
  });

  it('onError surfaces the error message, falling back when none is present', () => {
    const { onError } = createCopyExternalFilesHandlers(vi.fn());
    onError({ message: 'network down' });
    expect(error).toHaveBeenCalledWith('network down');
    onError('not-an-error-object');
    expect(error).toHaveBeenCalledWith('Failed to add files');
  });
});
