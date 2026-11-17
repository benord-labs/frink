import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { terminalRouter } from './terminal';

const emptyFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-servers-route-'));

afterAll(() => {
  fs.rmSync(emptyFolder, { recursive: true, force: true });
});

describe('terminal.devServers', () => {
  it('streams the list for a chat folder through the real scanner', async () => {
    const caller = terminalRouter.createCaller({ getWindow: () => null });
    const received: unknown[] = [];
    const subscription = (await caller.devServers({ path: emptyFolder })).subscribe({
      next: (links) => received.push(links),
    });

    await expect.poll(() => received.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(received.at(-1)).toEqual([]);
    subscription.unsubscribe();
  });

  it('refuses an empty folder path', async () => {
    const caller = terminalRouter.createCaller({ getWindow: () => null });
    await expect(caller.devServers({ path: '' })).rejects.toThrow();
  });
});
