import { describe, expect, it } from 'vitest';
import { createAppRouter } from './index';

describe('power router', () => {
  it('is registered where the Preferences switch calls it', () => {
    const procedures = Object.keys(createAppRouter(() => null)._def.procedures);
    expect(procedures).toEqual(
      expect.arrayContaining(['power.keepAwakeWhileWorking', 'power.setKeepAwakeWhileWorking']),
    );
  });
});
