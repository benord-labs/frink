import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getProjectByIdMock, syncMock, hasAllowMock } = vi.hoisted(() => ({
  getProjectByIdMock: vi.fn(),
  syncMock: vi.fn(),
  hasAllowMock: vi.fn(),
}));

vi.mock('../db/repos/projects', () => ({
  getProjectById: (...args: unknown[]) => getProjectByIdMock(...args),
}));
// syncMock stands in for the file reconcile; each call is one in-call attempt.
vi.mock('./cursor-config-sync', () => ({
  reconcileBashRuleInCursorConfig: (...args: unknown[]) => syncMock(...args),
}));
vi.mock('./v2/store-local', () => ({
  hasProjectAllowRuleIgnoringPadding: (...args: unknown[]) => hasAllowMock(...args),
}));
vi.mock('electron', () => ({ app: { getPath: () => '/mock' } }));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  listPendingCursorSyncs,
  retryPendingCursorSyncs,
  syncProjectRuleToCursor,
  syncProjectRuleToCursorDurably,
} from './cursor-sync-pending';

const db = {} as Parameters<typeof syncProjectRuleToCursorDurably>[0];
const PROJECT = { id: 'p1', path: '/repo' };
let file: string;

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'frink-cursor-pending-')), 'cursor-sync-pending.json');
  getProjectByIdMock.mockReset().mockResolvedValue(PROJECT);
  syncMock.mockReset().mockResolvedValue(undefined);
  hasAllowMock.mockReset().mockResolvedValue(false);
});

const failTimes = (n: number) => {
  for (let i = 0; i < n; i++) syncMock.mockRejectedValueOnce(new Error('EBUSY'));
};

const durably = (ruleString = 'Bash(npm:*)', projectId = 'p1') =>
  syncProjectRuleToCursorDurably(db, projectId, ruleString, { file, retryDelayMs: 0 });

describe('syncProjectRuleToCursorDurably (sc-3267)', () => {
  it('syncs the resolved project and leaves no pending file on success', async () => {
    await durably();
    expect(syncMock).toHaveBeenCalledWith('/repo', 'Bash(npm:*)', expect.any(Function));
    expect(existsSync(file)).toBe(false);
  });

  it('queues the rule when the sync exhausts its retries, and never throws', async () => {
    syncMock.mockRejectedValue(new Error('EBUSY'));
    await expect(durably()).resolves.toBeUndefined();
    expect(await listPendingCursorSyncs(file)).toEqual([
      { projectId: 'p1', ruleString: 'Bash(npm:*)' },
    ]);
  });

  it('queues when the project lookup itself fails', async () => {
    getProjectByIdMock.mockRejectedValue(new Error('SQLITE_BUSY'));
    await durably();
    expect(await listPendingCursorSyncs(file)).toHaveLength(1);
  });

  it('does not duplicate an entry that fails repeatedly', async () => {
    syncMock.mockRejectedValue(new Error('EBUSY'));
    await durably();
    await durably();
    expect(await listPendingCursorSyncs(file)).toHaveLength(1);
  });

  it('a later successful sync of the same rule clears its pending entry', async () => {
    failTimes(3);
    await durably('Bash(npm:*)');
    failTimes(3);
    await durably('Bash(git:*)');
    await durably('Bash(npm:*)');
    expect(await listPendingCursorSyncs(file)).toEqual([
      { projectId: 'p1', ruleString: 'Bash(git:*)' },
    ]);
  });

  it('concurrent failures for different rules are all queued (no lost update)', async () => {
    syncMock.mockRejectedValue(new Error('EBUSY'));
    await Promise.all([durably('Bash(npm:*)'), durably('Bash(git:*)'), durably('Bash(pnpm:*)')]);
    const rules = (await listPendingCursorSyncs(file)).map((e) => e.ruleString).sort();
    expect(rules).toEqual(['Bash(git:*)', 'Bash(npm:*)', 'Bash(pnpm:*)']);
  });

  it('a slow success cannot clear the entry queued by a newer failure for the same rule', async () => {
    let releaseFirst: () => void = () => {};
    syncMock.mockImplementationOnce(() => new Promise<void>((r) => (releaseFirst = r)));
    failTimes(3);
    const first = durably(); // e.g. revoke sync, stalls before clearing
    const second = durably(); // e.g. re-grant sync, fails
    await vi.waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);
    expect(await listPendingCursorSyncs(file)).toEqual([
      { projectId: 'p1', ruleString: 'Bash(npm:*)' },
    ]);
  });

  it('different rules are not serialised behind each other', async () => {
    let releaseFirst: () => void = () => {};
    syncMock.mockImplementationOnce(() => new Promise<void>((r) => (releaseFirst = r)));
    const first = durably('Bash(npm:*)');
    await vi.waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    await durably('Bash(git:*)'); // must not wait for npm's stalled sync
    expect(syncMock).toHaveBeenCalledTimes(2);
    releaseFirst();
    await first;
  });

  it('writes the queue atomically (no temp file left behind, always valid JSON)', async () => {
    syncMock.mockRejectedValue(new Error('EBUSY'));
    await Promise.all([durably('Bash(npm:*)'), durably('Bash(git:*)')]);
    expect(await readdir(dirname(file))).toEqual(['cursor-sync-pending.json']);
    expect(Array.isArray(JSON.parse(await readFile(file, 'utf-8')))).toBe(true);
  });

  it('still resolves when even the pending file cannot be written', async () => {
    syncMock.mockRejectedValue(new Error('EBUSY'));
    await expect(
      syncProjectRuleToCursorDurably(db, 'p1', 'Bash(npm:*)', {
        file: join(file, 'no-such-dir', 'pending.json'),
        retryDelayMs: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('treats a corrupt or wrong-shaped pending file as empty', async () => {
    await writeFile(file, '{ nope', 'utf-8');
    expect(await listPendingCursorSyncs(file)).toEqual([]);
    await writeFile(
      file,
      JSON.stringify([{ projectId: 1 }, { projectId: 'p1', ruleString: 'Bash(a:*)' }]),
    );
    expect(await listPendingCursorSyncs(file)).toEqual([
      { projectId: 'p1', ruleString: 'Bash(a:*)' },
    ]);
  });
});

describe('retryPendingCursorSyncs — boot sweep', () => {
  async function seed(entries: { projectId: string; ruleString: string }[]) {
    await writeFile(file, JSON.stringify(entries), 'utf-8');
  }

  it('replays every entry and drops the ones that now succeed', async () => {
    await seed([
      { projectId: 'p1', ruleString: 'Bash(npm:*)' },
      { projectId: 'p1', ruleString: 'Bash(git:*)' },
    ]);
    await retryPendingCursorSyncs(db, { file, retryDelayMs: 0 });
    expect(syncMock).toHaveBeenCalledTimes(2);
    expect(await listPendingCursorSyncs(file)).toEqual([]);
  });

  it('keeps entries that still fail', async () => {
    await seed([
      { projectId: 'p1', ruleString: 'Bash(npm:*)' },
      { projectId: 'p1', ruleString: 'Bash(git:*)' },
    ]);
    syncMock.mockImplementation(async (_path, rule: string) => {
      if (rule === 'Bash(git:*)') throw new Error('EACCES');
    });
    await retryPendingCursorSyncs(db, { file, retryDelayMs: 0 });
    expect(await listPendingCursorSyncs(file)).toEqual([
      { projectId: 'p1', ruleString: 'Bash(git:*)' },
    ]);
  });

  it('drops entries whose project was deleted', async () => {
    await seed([{ projectId: 'gone', ruleString: 'Bash(npm:*)' }]);
    getProjectByIdMock.mockResolvedValue(null);
    await retryPendingCursorSyncs(db, { file, retryDelayMs: 0 });
    expect(syncMock).not.toHaveBeenCalled();
    expect(await listPendingCursorSyncs(file)).toEqual([]);
  });

  it('is a no-op with no pending file', async () => {
    await retryPendingCursorSyncs(db, { file, retryDelayMs: 0 });
    expect(syncMock).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the file readable after a sweep that changed it', async () => {
    await seed([{ projectId: 'p1', ruleString: 'Bash(npm:*)' }]);
    await retryPendingCursorSyncs(db, { file, retryDelayMs: 0 });
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual([]);
  });
});

describe('syncProjectRuleToCursor — DB check + in-call retries', () => {
  it('derives "allowed" from the padding-tolerant project allow lookup', async () => {
    hasAllowMock.mockResolvedValue(true);
    await syncProjectRuleToCursor(db, PROJECT, ' Bash(npm:*) ');
    const isAllowed = syncMock.mock.calls[0][2] as () => Promise<boolean>;
    await expect(isAllowed()).resolves.toBe(true);
    expect(hasAllowMock).toHaveBeenCalledWith(db, 'p1', ' Bash(npm:*) ');
  });

  it('retries transient failures and succeeds', async () => {
    failTimes(2);
    await expect(
      syncProjectRuleToCursor(db, PROJECT, 'Bash(npm:*)', { retryDelayMs: 0 }),
    ).resolves.toBeUndefined();
    expect(syncMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 attempts and surfaces the last error', async () => {
    syncMock.mockRejectedValue(new Error('EACCES'));
    await expect(
      syncProjectRuleToCursor(db, PROJECT, 'Bash(npm:*)', { retryDelayMs: 0 }),
    ).rejects.toThrow('EACCES');
    expect(syncMock).toHaveBeenCalledTimes(3);
  });

  it('a single transient failure inside the durable path is retried, not queued', async () => {
    failTimes(1);
    await durably();
    expect(existsSync(file)).toBe(false);
  });
});
