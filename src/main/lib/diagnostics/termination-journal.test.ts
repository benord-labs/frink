import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DiagnosticContext } from '../../../shared/sentry/diagnostic-context';
import {
  classifyPriorSession,
  parseCorrelatedMainOomReportPrefix,
  readTerminationState,
  TerminationJournal,
  type TerminationSessionIdentity,
} from './termination-journal';

const dirs: string[] = [];
const BOOT_SESSION_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOOT_SESSION_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frink-termination-journal-'));
  dirs.push(dir);
  return join(dir, 'runtime-termination.json');
}

function identity(overrides: Partial<TerminationSessionIdentity> = {}): TerminationSessionIdentity {
  return {
    sessionId: 'session-a',
    pid: 123,
    processStartedAtMs: 1_000,
    sessionStartedAtMs: 1_100,
    bootSessionToken: BOOT_SESSION_A,
    ...overrides,
  };
}

const snapshot = {
  schema_version: 1,
  sampled_at_ms: 1_200,
  sample_sequence: 1,
  main_heap_used_mb: 10,
} as DiagnosticContext;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TerminationJournal', () => {
  it('reads the prior record before replacing it with the new running session', async () => {
    const file = await tempFile();
    const first = new TerminationJournal(file);
    expect(await first.beginSession(identity())).toBeNull();
    await first.updateSnapshot(snapshot);

    const second = new TerminationJournal(file);
    const prior = await second.beginSession(identity({ sessionId: 'session-b', pid: 456 }));

    expect(prior).toMatchObject({
      sessionId: 'session-a',
      lifecycle: 'running',
      latestSnapshot: snapshot,
    });
    expect(await readTerminationState(file)).toMatchObject({
      sessionId: 'session-b',
      lifecycle: 'running',
    });
  });

  it('serializes sample and terminal writes so clean cannot be overwritten by an older update', async () => {
    const file = await tempFile();
    const journal = new TerminationJournal(file);
    await journal.beginSession(identity());

    const olderSample = journal.updateSnapshot(snapshot);
    const shutdownStarted = journal.markLifecycle('shutdown_started');
    const clean = journal.markLifecycle('clean');
    await Promise.all([olderSample, shutdownStarted, clean]);

    const state = await readTerminationState(file);
    expect(state?.lifecycle).toBe('clean');
    expect(state?.revision).toBe(4);
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('environment');
  });

  it('recovers from a malformed app-owned marker instead of disabling future diagnostics', async () => {
    const file = await tempFile();
    await writeFile(file, '{"schemaVersion":', 'utf8');

    const journal = new TerminationJournal(file);
    expect(await journal.beginSession(identity())).toBeNull();
    expect(await readTerminationState(file)).toMatchObject({
      sessionId: 'session-a',
      lifecycle: 'running',
    });
  });

  it('keeps the current session writable after reading the prior marker fails', async () => {
    const file = await tempFile();
    const readError = Object.assign(new Error('temporarily unavailable'), { code: 'EMFILE' });
    const journal = new TerminationJournal(
      file,
      () => 2_000,
      async () => {
        throw readError;
      },
    );

    await expect(journal.beginSession(identity())).rejects.toBe(readError);
    await journal.updateSnapshot(snapshot);
    await journal.markLifecycle('clean');

    expect(await readTerminationState(file)).toMatchObject({
      lifecycle: 'clean',
      revision: 3,
      latestSnapshot: snapshot,
    });
  });

  it('classifies dirty sessions honestly and requires explicit evidence for a host restart', () => {
    const prior = {
      schemaVersion: 1 as const,
      ...identity(),
      lifecycle: 'running' as const,
      revision: 2,
      updatedAtMs: 1_500,
      latestSnapshot: snapshot,
    };

    expect(
      classifyPriorSession(prior, {
        bootSessionToken: BOOT_SESSION_A,
        confirmedMainOom: false,
      }),
    ).toBe('unclean_app_termination');
    expect(classifyPriorSession(prior, { confirmedMainOom: false })).toBe(
      'unclean_app_termination',
    );
    expect(
      classifyPriorSession(prior, {
        bootSessionToken: BOOT_SESSION_B,
        confirmedMainOom: false,
      }),
    ).toBe('host_restart_after_unclean_session');
    expect(
      classifyPriorSession(prior, {
        bootSessionToken: BOOT_SESSION_A,
        confirmedMainOom: true,
      }),
    ).toBe('confirmed_main_oom');
    expect(
      classifyPriorSession(
        { ...prior, lifecycle: 'clean' },
        { bootSessionToken: BOOT_SESSION_B, confirmedMainOom: true },
      ),
    ).toBeNull();
  });

  it('drops an invalid boot-session token instead of trusting corrupted reboot evidence', async () => {
    const file = await tempFile();
    const journal = new TerminationJournal(file);
    await journal.beginSession(identity());
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...raw, bootSessionToken: 'not-a-token' }), 'utf8');

    expect(await readTerminationState(file)).not.toHaveProperty('bootSessionToken');
  });
});

describe('parseCorrelatedMainOomReportPrefix', () => {
  const report = (
    pid: number,
    timestamp: number,
    event = 'Allocation failed - JavaScript heap out of memory',
  ) =>
    JSON.stringify({
      header: {
        event,
        dumpEventTimeStamp: String(timestamp),
        processId: pid,
        commandLine: ['never', 'returned'],
      },
    });

  it('accepts only an OOM report for the prior PID and process lifetime', () => {
    const prior = identity({ processStartedAtMs: 10_000 });
    expect(parseCorrelatedMainOomReportPrefix(report(123, 14_000), prior, 20_000)).toEqual({
      kind: 'main_v8_oom',
      occurredAtMs: 14_000,
    });
    expect(parseCorrelatedMainOomReportPrefix(report(999, 14_000), prior, 20_000)).toBeNull();
    expect(parseCorrelatedMainOomReportPrefix(report(123, 4_000), prior, 20_000)).toBeNull();
    expect(parseCorrelatedMainOomReportPrefix(report(123, 26_000), prior, 20_000)).toBeNull();
    expect(
      parseCorrelatedMainOomReportPrefix(report(123, 14_000, 'SIGABRT'), prior, 20_000),
    ).toBeNull();
  });

  it('fails closed on malformed or incomplete input', () => {
    expect(parseCorrelatedMainOomReportPrefix('{"header":', identity(), 2_000)).toBeNull();
    expect(
      parseCorrelatedMainOomReportPrefix('{"event":"heap out of memory"}', identity(), 2_000),
    ).toBeNull();
  });
});
