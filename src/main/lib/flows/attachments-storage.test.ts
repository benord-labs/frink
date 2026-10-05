import { describe, expect, it } from 'vitest';

import { parseAttachmentUrl, storedAttachmentFilename } from './attachments-storage';

describe('storedAttachmentFilename', () => {
  it.each([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
  ])('maps %s to a %s name that is safe as a path segment', (mime, ext) => {
    const name = storedAttachmentFilename(mime);
    expect(name.endsWith(ext)).toBe(true);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('never repeats across many calls', () => {
    const names = new Set(
      Array.from({ length: 1000 }, () => storedAttachmentFilename('image/png')),
    );
    expect(names.size).toBe(1000);
  });

  it('falls back to a bare id for an unknown mime type', () => {
    expect(storedAttachmentFilename('image/gif')).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe('parseAttachmentUrl', () => {
  it('splits a well-formed URL', () => {
    expect(parseAttachmentUrl('frink-attachment://run1/a-b_c.png')).toEqual({
      runId: 'run1',
      filename: 'a-b_c.png',
    });
  });

  it.each([
    ['https://example.com/x.png'],
    ['file:///etc/passwd'],
    ['FRINK-ATTACHMENT://run1/x.png'],
    ['frink-attachment://run1'],
    ['frink-attachment://run1/'],
    ['frink-attachment:///x.png'],
    ['frink-attachment://run1/a/b.png'],
    ['frink-attachment://run1/x.png?v=1'],
    ['frink-attachment://run1/with space.png'],
    ['frink-attachment://run1/..%2Fescape.png'],
    [''],
  ])('returns null for %j', (url) => {
    expect(parseAttachmentUrl(url)).toBeNull();
  });
});
