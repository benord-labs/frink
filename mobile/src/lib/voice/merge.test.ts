import { describe, expect, it } from 'vitest';
import { mergeDictation } from './merge';

describe('mergeDictation', () => {
  it('starts an empty draft with the transcript, capitalised', () => {
    expect(mergeDictation('', 'fix the login page')).toBe('Fix the login page');
    expect(mergeDictation('  ', ' hello ')).toBe('Hello');
  });

  it('joins an existing draft with one space and leaves mid-sentence words as spoken', () => {
    expect(mergeDictation('Please', 'check the tests')).toBe('Please check the tests');
    expect(mergeDictation('Please ', 'check')).toBe('Please check');
    expect(mergeDictation('Line one\n', 'next')).toBe('Line one\nnext');
  });

  it('capitalises a new sentence after a full stop', () => {
    expect(mergeDictation('Done.', 'now run it')).toBe('Done. Now run it');
  });

  it('replaces an earlier partial because every partial merges onto the same base', () => {
    const base = 'Note:';
    mergeDictation(base, 'open');
    expect(mergeDictation(base, 'open the file')).toBe('Note: open the file');
  });

  it('keeps the draft when nothing was heard', () => {
    expect(mergeDictation('Keep me', '  ')).toBe('Keep me');
  });
});
