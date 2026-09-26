import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  resolveWriteToolFilePathForIpc,
  tryBuildWriteToolFileChangedPayload,
  WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC,
} from './claude-file-changed';

describe('resolveWriteToolFilePathForIpc', () => {
  it('returns absolute paths unchanged', () => {
    expect(resolveWriteToolFilePathForIpc('/abs/a.md', '/wt/root')).toBe('/abs/a.md');
  });

  it('resolves relative paths against cwd', () => {
    expect(resolveWriteToolFilePathForIpc('PR_DESCRIPTION.md', '/wt/root')).toBe(
      path.resolve('/wt/root', 'PR_DESCRIPTION.md'),
    );
  });

  it('returns null for relative path when cwd is missing', () => {
    expect(resolveWriteToolFilePathForIpc('foo.md', undefined)).toBeNull();
  });

  it('returns null for empty raw path', () => {
    expect(resolveWriteToolFilePathForIpc('', '/wt')).toBeNull();
  });
});

describe('WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC', () => {
  it('includes Write, Edit, MultiEdit, NotebookEdit, Delete', () => {
    expect(WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC.has('tool-Write')).toBe(true);
    expect(WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC.has('tool-Edit')).toBe(true);
    expect(WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC.has('tool-MultiEdit')).toBe(true);
    expect(WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC.has('tool-NotebookEdit')).toBe(true);
    expect(WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC.has('tool-Delete')).toBe(true);
  });

  it('does not include unrelated tools', () => {
    expect(WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC.has('tool-Read')).toBe(false);
    expect(WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC.has('tool-Bash')).toBe(false);
  });
});

describe('tryBuildWriteToolFileChangedPayload', () => {
  const wt = '/Users/proj/.frink/worktrees/foo/bar';

  it('returns null for non-write tool parts (e.g. Read)', () => {
    expect(tryBuildWriteToolFileChangedPayload('tool-Read', { file_path: 'x.ts' }, wt)).toBeNull();
  });

  it('returns null when file_path is missing', () => {
    expect(tryBuildWriteToolFileChangedPayload('tool-Write', {}, wt)).toBeNull();
  });

  it('returns null when file_path is not a string (SDK / malformed input)', () => {
    expect(
      tryBuildWriteToolFileChangedPayload('tool-Write', { file_path: 99 as unknown as string }, wt),
    ).toBeNull();
    expect(
      tryBuildWriteToolFileChangedPayload(
        'tool-Edit',
        { file_path: null as unknown as string },
        wt,
      ),
    ).toBeNull();
  });

  it('does not use legacy `file` key — only file_path', () => {
    expect(tryBuildWriteToolFileChangedPayload('tool-Write', { file: 'legacy.md' }, wt)).toBeNull();
  });

  it('returns resolved path for Write, Edit, MultiEdit, NotebookEdit, Delete when file_path + cwd are valid', () => {
    const input = { file_path: 'PR_DESCRIPTION.md' };
    const expected = { filePath: path.resolve(wt, 'PR_DESCRIPTION.md') };
    expect(tryBuildWriteToolFileChangedPayload('tool-Write', input, wt)).toEqual(expected);
    expect(tryBuildWriteToolFileChangedPayload('tool-Edit', input, wt)).toEqual(expected);
    expect(tryBuildWriteToolFileChangedPayload('tool-MultiEdit', input, wt)).toEqual(expected);
    expect(tryBuildWriteToolFileChangedPayload('tool-NotebookEdit', input, wt)).toEqual(expected);
    expect(tryBuildWriteToolFileChangedPayload('tool-Delete', input, wt)).toEqual(expected);
  });
});
