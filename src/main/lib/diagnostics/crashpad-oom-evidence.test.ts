import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCrashpadCaptureForTests,
  type CrashpadHandler,
  findFreshMinidump,
  markCrashpadShutdown,
  startCrashpadCapture,
} from './crashpad-oom-evidence';

const CAPTURE_STARTED_AT_MS = 1_000_000;
const dirs: string[] = [];
const acceptAll = () => true;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'frink-crashpad-'));
  dirs.push(root);
  await mkdir(join(root, 'completed'), { recursive: true });
  return root;
}

/** Smallest Crashpad-shaped dump: header, one CrashpadInfo directory entry, empty module list. */
function emptyCrashpadDump(): Buffer {
  const header = Buffer.alloc(32);
  header.write('MDMP', 0, 'latin1');
  header.writeUInt32LE(0xa793, 4);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(32, 12);
  const directory = Buffer.alloc(12);
  directory.writeUInt32LE(0x43500001, 0);
  directory.writeUInt32LE(52, 4);
  directory.writeUInt32LE(48, 8);
  const moduleList = Buffer.alloc(4);
  const info = Buffer.alloc(52);
  info.writeUInt32LE(4, 44);
  info.writeUInt32LE(44, 48);
  return Buffer.concat([header, directory, moduleList, info]);
}

async function writeDump(root: string, name: string, mtimeMs: number, body?: Buffer) {
  const filePath = join(root, 'completed', name);
  await writeFile(filePath, body ?? emptyCrashpadDump());
  await utimes(filePath, mtimeMs / 1_000, mtimeMs / 1_000);
  return filePath;
}

const noopHandler: CrashpadHandler = { start: () => {}, reportStartFailure: () => {} };

async function startedCapture(clock: { now: number }): Promise<string> {
  const root = await tempRoot();
  startCrashpadCapture(
    { startHandler: true, dumpDirectory: root, now: () => clock.now },
    noopHandler,
  );
  return root;
}

function fakeHandler(start: CrashpadHandler['start']): CrashpadHandler & { failures: Error[] } {
  const failures: Error[] = [];
  return { start, reportStartFailure: (error) => failures.push(error), failures };
}

afterEach(async () => {
  _resetCrashpadCaptureForTests();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('startCrashpadCapture', () => {
  it('starts the handler with upload off only when nothing else owns it', async () => {
    const start = vi.fn();
    const handler = fakeHandler(start);

    expect(startCrashpadCapture({ startHandler: false, dumpDirectory: '/dumps' }, handler)).toBe(
      true,
    );
    expect(start).not.toHaveBeenCalled();
    // Another owner's handler means its pipeline carries the evidence: no local reading.
    await expect(findFreshMinidump(Date.now(), { accept: acceptAll })).resolves.toBeNull();

    _resetCrashpadCaptureForTests();
    expect(startCrashpadCapture({ startHandler: true, dumpDirectory: '/dumps' }, handler)).toBe(
      true,
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ uploadToServer: false, ignoreSystemCrashHandler: false }),
    );
  });

  it('reports a handler that failed to start instead of pretending evidence will arrive', () => {
    const failure = new Error('handler missing');
    const handler = fakeHandler(() => {
      throw failure;
    });

    expect(startCrashpadCapture({ startHandler: true, dumpDirectory: '/dumps' }, handler)).toBe(
      false,
    );
    expect(handler.failures).toEqual([failure]);
  });
});

describe('findFreshMinidump', () => {
  it('claims the oldest settled dump written after the death and never a dump from before it', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    const crashedAtMs = CAPTURE_STARTED_AT_MS + 10_000;
    await writeDump(root, 'earlier-death.dmp', crashedAtMs - 5_000);
    const own = await writeDump(root, 'own.dmp', crashedAtMs + 500);
    await writeDump(root, 'next-death.dmp', crashedAtMs + 900);
    clock.now = crashedAtMs + 4_000;
    const now = () => clock.now;

    const search = () => findFreshMinidump(crashedAtMs, { accept: acceptAll, now, timeoutMs: 0 });
    await expect(search()).resolves.toEqual({ path: own, annotations: {} });
    await expect(search()).resolves.toMatchObject({ path: expect.stringContaining('next-death') });
    await expect(search()).resolves.toBeNull();
  });

  it('leaves a dump the death cannot own for another death to claim', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    const crashedAtMs = CAPTURE_STARTED_AT_MS + 10_000;
    const dump = await writeDump(root, 'other.dmp', crashedAtMs + 500);
    clock.now = crashedAtMs + 4_000;
    const now = () => clock.now;

    await expect(
      findFreshMinidump(crashedAtMs, { accept: () => false, now, timeoutMs: 0 }),
    ).resolves.toBeNull();
    await expect(
      findFreshMinidump(crashedAtMs, { accept: acceptAll, now, timeoutMs: 0 }),
    ).resolves.toMatchObject({ path: dump });
  });

  it('claims and reports a malformed dump without confirming anything', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    const crashedAtMs = CAPTURE_STARTED_AT_MS + 10_000;
    const broken = await writeDump(root, 'broken.dmp', crashedAtMs + 500, Buffer.from('garbage'));
    clock.now = crashedAtMs + 4_000;
    const now = () => clock.now;
    const onMalformed = vi.fn();

    await expect(
      findFreshMinidump(crashedAtMs, { accept: acceptAll, onMalformed, now, timeoutMs: 0 }),
    ).resolves.toBeNull();
    expect(onMalformed).toHaveBeenCalledWith(broken);
    await expect(
      findFreshMinidump(crashedAtMs, { accept: acceptAll, onMalformed, now, timeoutMs: 0 }),
    ).resolves.toBeNull();
    expect(onMalformed).toHaveBeenCalledTimes(1);
  });

  it('treats a dump Crashpad promoted between directories as one report', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    const crashedAtMs = CAPTURE_STARTED_AT_MS + 10_000;
    await mkdir(join(root, 'pending'), { recursive: true });
    await writeDump(root, 'same.dmp', crashedAtMs + 500);
    const pending = join(root, 'pending', 'same.dmp');
    await writeFile(pending, emptyCrashpadDump());
    await utimes(pending, (crashedAtMs + 500) / 1_000, (crashedAtMs + 500) / 1_000);
    clock.now = crashedAtMs + 4_000;
    const now = () => clock.now;

    await expect(
      findFreshMinidump(crashedAtMs, { accept: acceptAll, now, timeoutMs: 0 }),
    ).resolves.toMatchObject({ path: expect.stringContaining('same.dmp') });
    await expect(
      findFreshMinidump(crashedAtMs, { accept: acceptAll, now, timeoutMs: 0 }),
    ).resolves.toBeNull();
  });

  it('never hands one dump to two concurrent death searches', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    const crashedAtMs = CAPTURE_STARTED_AT_MS + 10_000;
    await writeDump(root, 'only.dmp', crashedAtMs + 500);
    clock.now = crashedAtMs + 4_000;
    const now = () => clock.now;

    const [first, second] = await Promise.all([
      findFreshMinidump(crashedAtMs, { accept: acceptAll, now, timeoutMs: 0 }),
      findFreshMinidump(crashedAtMs, { accept: acceptAll, now, timeoutMs: 0 }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('skips a dump that cannot be read without calling it malformed', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    const crashedAtMs = CAPTURE_STARTED_AT_MS + 10_000;
    // A directory named like a dump stats fine and fails to read, like a file Crashpad just moved.
    await mkdir(join(root, 'completed', 'moved.dmp'));
    clock.now = crashedAtMs + 4_000;
    const onMalformed = vi.fn();

    await expect(
      findFreshMinidump(crashedAtMs, {
        accept: acceptAll,
        onMalformed,
        now: () => clock.now,
        timeoutMs: 0,
      }),
    ).resolves.toBeNull();
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it('waits for a dump Crashpad may still be writing', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    const crashedAtMs = CAPTURE_STARTED_AT_MS + 10_000;
    clock.now = crashedAtMs + 1_000;
    const fresh = await writeDump(root, 'writing.dmp', clock.now - 500);
    const sleep = vi.fn(async () => {
      clock.now += 2_000;
    });

    const found = await findFreshMinidump(crashedAtMs, {
      accept: acceptAll,
      now: () => clock.now,
      sleep,
    });
    expect(found?.path).toBe(fresh);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout when no dump lands', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    await startedCapture(clock);
    const sleep = vi.fn(async () => {
      clock.now += 500;
    });

    await expect(
      findFreshMinidump(clock.now, {
        accept: acceptAll,
        now: () => clock.now,
        sleep,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeNull();
    expect(sleep).toHaveBeenCalled();
  });

  it('resolves empty at once when shutdown began, even with a dump on disk', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    await writeDump(root, 'fresh.dmp', clock.now + 500);
    clock.now += 5_000;
    markCrashpadShutdown();
    const sleep = vi.fn(async () => {});

    await expect(
      findFreshMinidump(clock.now - 5_000, { accept: acceptAll, now: () => clock.now, sleep }),
    ).resolves.toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns nothing when shutdown begins while a dump is being read', async () => {
    const clock = { now: CAPTURE_STARTED_AT_MS };
    const root = await startedCapture(clock);
    await writeDump(root, 'fresh.dmp', clock.now + 500);
    clock.now += 5_000;
    const accept = () => {
      markCrashpadShutdown();
      return true;
    };

    await expect(
      findFreshMinidump(clock.now - 5_000, { accept, now: () => clock.now, timeoutMs: 0 }),
    ).resolves.toBeNull();
  });

  it('is inert before capture starts', async () => {
    await expect(findFreshMinidump(Date.now(), { accept: acceptAll })).resolves.toBeNull();
  });
});
