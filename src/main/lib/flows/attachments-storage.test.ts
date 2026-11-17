import { describe, expect, it } from 'vitest';

import { parseAttachmentUrl } from './attachments-storage';

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
