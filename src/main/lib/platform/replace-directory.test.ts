import { beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSyncMock, renameMock, rmMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  renameMock: vi.fn(),
  rmMock: vi.fn(),
}));

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }));
vi.mock('node:fs/promises', () => ({ rename: renameMock, rm: rmMock }));

import { replaceDirectory } from './replace-directory';

const sourcePath = '/data/widget.staging';
const destinationPath = '/data/widget';
const backupPath = '/data/widget.backup';

beforeEach(() => {
  existsSyncMock.mockReset().mockReturnValue(true);
  renameMock.mockReset().mockResolvedValue(undefined);
  rmMock.mockReset().mockResolvedValue(undefined);
});

describe('replaceDirectory', () => {
  it('swaps by rename and recursively removes the backup', async () => {
    await replaceDirectory(sourcePath, destinationPath, { backupPath });

    expect(existsSyncMock).toHaveBeenCalledWith(destinationPath);
    expect(renameMock.mock.calls).toEqual([
      [destinationPath, backupPath],
      [sourcePath, destinationPath],
    ]);
    expect(rmMock).toHaveBeenCalledWith(backupPath, { recursive: true, force: true });
  });

  it('restores the backup and rethrows the original error when the swap fails', async () => {
    const swapError = new Error('swap failed');
    renameMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(swapError);

    await expect(
      replaceDirectory(sourcePath, destinationPath, {
        backupPath,
        destinationExists: true,
      }),
    ).rejects.toBe(swapError);

    expect(renameMock.mock.calls).toEqual([
      [destinationPath, backupPath],
      [sourcePath, destinationPath],
      [backupPath, destinationPath],
    ]);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('reports a cleanup failure without failing the completed swap', async () => {
    const cleanupError = new Error('cleanup failed');
    const onCleanupError = vi.fn().mockRejectedValue(new Error('reporting failed'));
    rmMock.mockRejectedValueOnce(cleanupError);

    await expect(
      replaceDirectory(sourcePath, destinationPath, {
        backupPath,
        destinationExists: true,
        onCleanupError,
      }),
    ).resolves.toBeUndefined();

    expect(onCleanupError).toHaveBeenCalledWith(cleanupError);
  });

  it('uses caller-supplied destination state without probing the filesystem', async () => {
    await replaceDirectory(sourcePath, destinationPath, {
      backupPath,
      destinationExists: false,
    });

    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(renameMock).toHaveBeenCalledOnce();
    expect(renameMock).toHaveBeenCalledWith(sourcePath, destinationPath);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('propagates cleanup failure by default', async () => {
    const cleanupError = new Error('cleanup failed');
    rmMock.mockRejectedValueOnce(cleanupError);

    await expect(
      replaceDirectory(sourcePath, destinationPath, {
        backupPath,
        destinationExists: true,
      }),
    ).rejects.toBe(cleanupError);
  });

  it('reports restore failure while preserving the original swap error', async () => {
    const swapError = new Error('swap failed');
    const restoreError = new Error('restore failed');
    const onRestoreError = vi.fn().mockRejectedValue(new Error('reporting failed'));
    renameMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(swapError)
      .mockRejectedValueOnce(restoreError);

    await expect(
      replaceDirectory(sourcePath, destinationPath, {
        backupPath,
        destinationExists: true,
        onRestoreError,
      }),
    ).rejects.toBe(swapError);

    expect(onRestoreError).toHaveBeenCalledWith(restoreError);
  });

  it('keeps the backup until post-swap verification succeeds and rolls back a mismatch', async () => {
    const verificationError = new Error('destination digest mismatch');
    const verifyDestination = vi.fn().mockRejectedValue(verificationError);

    await expect(
      replaceDirectory(sourcePath, destinationPath, {
        backupPath,
        destinationExists: true,
        verifyDestination,
      }),
    ).rejects.toBe(verificationError);

    expect(verifyDestination).toHaveBeenCalledWith(destinationPath);
    expect(renameMock.mock.calls).toEqual([
      [destinationPath, backupPath],
      [sourcePath, destinationPath],
      [backupPath, destinationPath],
    ]);
    expect(rmMock).toHaveBeenCalledOnce();
    expect(rmMock).toHaveBeenCalledWith(destinationPath, { recursive: true, force: true });
  });

  it('removes the retained backup only after successful destination verification', async () => {
    const verifyDestination = vi.fn(async () => {
      expect(rmMock).not.toHaveBeenCalled();
    });

    await replaceDirectory(sourcePath, destinationPath, {
      backupPath,
      destinationExists: true,
      verifyDestination,
    });

    expect(verifyDestination).toHaveBeenCalledWith(destinationPath);
    expect(rmMock).toHaveBeenCalledWith(backupPath, { recursive: true, force: true });
  });

  it('verifies the captured destination baseline before installing the candidate', async () => {
    const baselineError = new Error('destination baseline changed');
    const verifyBackup = vi.fn().mockRejectedValue(baselineError);
    const verifyDestination = vi.fn();

    await expect(
      replaceDirectory(sourcePath, destinationPath, {
        backupPath,
        destinationExists: true,
        verifyBackup,
        verifyDestination,
      }),
    ).rejects.toBe(baselineError);

    expect(verifyBackup).toHaveBeenCalledWith(backupPath);
    expect(verifyDestination).not.toHaveBeenCalled();
    expect(renameMock.mock.calls).toEqual([
      [destinationPath, backupPath],
      [backupPath, destinationPath],
    ]);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('surfaces the recovery path and preserves its backup when verified rollback fails', async () => {
    const recoveryPath = '/data/.widget.recovery';
    const verificationError = new Error('destination digest mismatch');
    const restoreError = new Error('restore denied');
    const onRestoreError = vi.fn();
    renameMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(restoreError);

    await expect(
      replaceDirectory(sourcePath, destinationPath, {
        backupPath: recoveryPath,
        destinationExists: true,
        onRestoreError,
        verifyDestination: vi.fn().mockRejectedValue(verificationError),
      }),
    ).rejects.toThrow(`Previous directory backup preserved at "${recoveryPath}"`);

    expect(onRestoreError).toHaveBeenCalledWith(restoreError);
    expect(rmMock).toHaveBeenCalledWith(destinationPath, { recursive: true, force: true });
    expect(rmMock).not.toHaveBeenCalledWith(recoveryPath, expect.anything());
  });
});
