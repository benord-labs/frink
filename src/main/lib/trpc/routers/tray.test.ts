import { afterEach, describe, expect, it, vi } from 'vitest';
import * as database from '../../db';
import { freshDb } from '../../db/test-utils/fresh-db';
import { trayRouter } from './tray';

afterEach(() => vi.restoreAllMocks());

describe('trayRouter', () => {
  it('shows the menu bar status by default and remembers turning it off', async () => {
    vi.spyOn(database, 'getDatabase').mockReturnValue(freshDb());
    const caller = trayRouter.createCaller({ getWindow: () => null });

    expect(await caller.showStatus()).toEqual({
      enabled: true,
      appliesOnRestart: process.platform === 'linux',
    });
    expect(await caller.setShowStatus({ enabled: false })).toEqual({ enabled: false });
    expect((await caller.showStatus()).enabled).toBe(false);
  });
});
