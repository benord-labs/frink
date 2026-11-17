import { describe, expect, it } from 'vitest';
import { createAppRouter } from './index';

describe('createAppRouter', () => {
  it('serves the secret form to the renderer', () => {
    const procedures = Object.keys(createAppRouter(() => null)._def.procedures);

    expect(procedures).toEqual(
      expect.arrayContaining([
        'secretRequests.pending',
        'secretRequests.submit',
        'secretRequests.decline',
      ]),
    );
  });
});
