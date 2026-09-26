import { describe, expect, it, vi } from 'vitest';
import { duplicateFileToDestination, pasteCopiedPath } from './internal-copy-paste';

describe('internal copy/paste helpers', () => {
  it('forwards duplicate payload to mutation', () => {
    const mutate = vi.fn();

    duplicateFileToDestination({
      mutate,
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '.claude',
    });

    expect(mutate).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '.claude',
    });
  });

  it('no-ops paste when copiedPath is null', () => {
    const onDuplicate = vi.fn();
    const clearCopiedPath = vi.fn();

    pasteCopiedPath({
      copiedPath: null,
      targetFolder: '.claude',
      onDuplicate,
      clearCopiedPath,
    });

    expect(onDuplicate).not.toHaveBeenCalled();
    expect(clearCopiedPath).not.toHaveBeenCalled();
  });

  it('duplicates and clears buffer when copiedPath exists', () => {
    const onDuplicate = vi.fn();
    const clearCopiedPath = vi.fn();

    pasteCopiedPath({
      copiedPath: '.cursor/rules',
      targetFolder: '.claude',
      onDuplicate,
      clearCopiedPath,
    });

    expect(onDuplicate).toHaveBeenCalledWith('.cursor/rules', '.claude');
    expect(clearCopiedPath).toHaveBeenCalledOnce();
  });
});
