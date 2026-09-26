import { join } from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureMainLog, mainLogPath } from './main-log';

describe('configureMainLog', () => {
  const original = log.transports.file.resolvePathFn;
  beforeEach(() => {
    log.transports.file.resolvePathFn = original;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    log.transports.file.resolvePathFn = original;
  });

  it('writes asynchronously with a bounded file, leaving the default location alone', () => {
    vi.stubEnv('FRINK_LOG_DIR', undefined);
    configureMainLog();
    expect(log.transports.file.sync).toBe(false);
    expect(log.transports.file.maxSize).toBe(20 * 1024 * 1024);
    expect(log.transports.file.resolvePathFn).toBe(original);
  });

  it('relocates the log for an instance that owns a run directory', () => {
    vi.stubEnv('FRINK_LOG_DIR', '/runs/abc');
    configureMainLog();
    expect(log.transports.file.resolvePathFn).not.toBe(original);
    expect(mainLogPath('/runs/abc')).toBe(join('/runs/abc', 'main.log'));
  });
});
