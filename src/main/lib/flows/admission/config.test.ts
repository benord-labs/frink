import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const homeState = vi.hoisted(() => ({ path: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => homeState.path;
  // `default` too — a spread alone leaves it pointing at the real module (see test-mock-home).
  return { ...actual, default: { ...actual, homedir }, homedir };
});

type ConfigModule = typeof import('./config');
let config: ConfigModule;
const DEFAULT_CONFIG = {
  version: 1,
  concurrencyLimitEnabled: true,
  maxConcurrentRuns: 4,
} as const;

describe('Flow admission config', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os');
    homeState.path = await fs.mkdtemp(join(tmpdir(), 'frink-flow-admission-'));
    config = await import('./config');
  });

  afterEach(async () => {
    await fs.rm(homeState.path, { recursive: true, force: true });
  });

  it('defaults missing or wholly invalid configuration to enabled with four runs', async () => {
    await expect(config.readFlowAdmissionConfig()).resolves.toEqual(DEFAULT_CONFIG);

    await fs.mkdir(config.FRINK_FLOWS_DIR, { recursive: true });
    await fs.writeFile(
      config.FLOW_ADMISSION_CONFIG_PATH,
      JSON.stringify({ version: 1, concurrencyLimitEnabled: false, maxConcurrentRuns: 0 }),
    );
    await expect(config.readFlowAdmissionConfig()).resolves.toEqual(DEFAULT_CONFIG);

    await fs.writeFile(config.FLOW_ADMISSION_CONFIG_PATH, '{broken json');
    await expect(config.readFlowAdmissionConfig()).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('preserves the last numeric value when the limit is disabled', async () => {
    await config.updateFlowAdmissionConfig({ maxConcurrentRuns: 7 });
    const disabled = await config.updateFlowAdmissionConfig({ concurrencyLimitEnabled: false });

    expect(disabled).toEqual({
      version: 1,
      concurrencyLimitEnabled: false,
      maxConcurrentRuns: 7,
    });
    await expect(config.readFlowAdmissionConfig()).resolves.toEqual(disabled);
  });

  it('rejects invalid updates instead of persisting unsafe capacity', async () => {
    await expect(config.updateFlowAdmissionConfig({ maxConcurrentRuns: 0 })).rejects.toThrow(
      /integer from 1 to 20/,
    );
    await expect(config.updateFlowAdmissionConfig({ maxConcurrentRuns: 21 })).rejects.toThrow(
      /integer from 1 to 20/,
    );
    await expect(config.updateFlowAdmissionConfig({ maxConcurrentRuns: 1.5 })).rejects.toThrow(
      /integer from 1 to 20/,
    );
    await expect(
      config.updateFlowAdmissionConfig({ concurrencyLimitEnabled: 'yes' as unknown as boolean }),
    ).rejects.toThrow(/must be a boolean/);
  });

  it('serializes disjoint racing patches and leaves no temporary file', async () => {
    await Promise.all([
      config.updateFlowAdmissionConfig({ concurrencyLimitEnabled: false }),
      config.updateFlowAdmissionConfig({ maxConcurrentRuns: 9 }),
    ]);

    await expect(config.readFlowAdmissionConfig()).resolves.toEqual({
      version: 1,
      concurrencyLimitEnabled: false,
      maxConcurrentRuns: 9,
    });
    const files = await fs.readdir(config.FRINK_FLOWS_DIR);
    expect(files).toEqual(['config.json']);
  });
});
