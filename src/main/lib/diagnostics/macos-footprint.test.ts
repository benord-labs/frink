import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseFootprintJson, readRendererFootprints } from './macos-footprint';

// Hoisted because vi.mock is lifted above ordinary consts, and these mocks are read by the
// factories the moment the module under test imports its own dependencies.
const { execFileMock, readFileMock, unlinkMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  readFileMock: vi.fn(),
  unlinkMock: vi.fn(async () => undefined),
}));

// `promisify` returns a function carrying this symbol untouched, so `execFileAsync` is the mock.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('node:child_process', () => ({
  execFile: Object.assign(execFileMock, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileMock,
  }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  unlink: unlinkMock,
}));

const realPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * Captured from `footprint --noCategories -f bytes -j` (macOS 26.5.1), trimmed to parsed keys.
 * Swap appears only under `summary.total`, never per process.
 */
type FootprintDocumentOverrides = Partial<{
  'bytes per unit': number;
  unit: string;
  processes: unknown[];
  errors: unknown[];
  warnings: unknown[];
  summary: object;
}>;

function fixture(overrides: FootprintDocumentOverrides = {}): string {
  return JSON.stringify({
    unit: 'byte',
    'bytes per unit': 1,
    processes: [
      {
        name: 'Electron Helper (Renderer)',
        pid: 51377,
        translated: false,
        'page size': 16384,
        footprint: 2161568168,
        auxiliary: { phys_footprint_peak: 16930646152, phys_footprint: 2162485672 },
      },
      {
        name: 'Electron Helper (Renderer)',
        pid: 51380,
        translated: false,
        'page size': 16384,
        footprint: 268402688,
        auxiliary: { phys_footprint_peak: 300000000, phys_footprint: 268435456 },
      },
    ],
    errors: [],
    warnings: [],
    summary: {
      total: {
        dirty: 2161568168,
        swapped: 1547501568,
        clean: 68829184,
        reclaimable: 5439488,
        wired: 0,
        regions: 300275,
      },
    },
    'total footprint': 2161568168,
    'page size': 16384,
    ...overrides,
  });
}

describe('parseFootprintJson', () => {
  it('reads phys_footprint per process and swap as a single aggregate', () => {
    const sample = parseFootprintJson(fixture());

    expect(sample?.perPid.get(51377)).toEqual({
      physFootprintKb: 2_111_802,
      peakKb: 16_533_834,
    });
    expect(sample?.perPid.get(51380)).toEqual({ physFootprintKb: 262_144, peakKb: 292_969 });
    expect(sample?.swappedKb).toBe(1_511_232);
  });

  it('keeps the surviving processes when one exited before the probe ran', () => {
    // footprint(1) omits a process that has gone away and still reports no errors or warnings,
    // so a partial document is normal churn rather than a failure.
    const sample = parseFootprintJson(
      fixture({
        processes: [
          {
            pid: 51377,
            auxiliary: { phys_footprint_peak: 16930646152, phys_footprint: 2162485672 },
          },
        ],
      }),
    );

    expect(sample?.perPid.size).toBe(1);
    expect(sample?.perPid.has(51377)).toBe(true);
  });

  it('rejects a document whose values are not bytes', () => {
    // A unit change would otherwise be read as bytes and under-report by the page size.
    expect(parseFootprintJson(fixture({ 'bytes per unit': 16384, unit: 'page' }))).toBeNull();
  });

  it('rejects a document reporting errors or warnings', () => {
    expect(parseFootprintJson(fixture({ errors: ['could not read task'] }))).toBeNull();
    expect(parseFootprintJson(fixture({ warnings: ['partial data'] }))).toBeNull();
  });

  it('rejects a document describing no usable process', () => {
    expect(parseFootprintJson(fixture({ processes: [] }))).toBeNull();
    expect(parseFootprintJson(fixture({ processes: [{ pid: 51377 }] }))).toBeNull();
  });

  it('keeps a zero footprint but drops impossible values', () => {
    // JSON has no NaN or Infinity: footprint(1) emits null for an unreadable figure.
    const sample = parseFootprintJson(
      fixture({
        processes: [
          { pid: 1, auxiliary: { phys_footprint: 0, phys_footprint_peak: 0 } },
          { pid: 2, auxiliary: { phys_footprint: -1, phys_footprint_peak: 10_000 } },
          { pid: 3, auxiliary: { phys_footprint: 10_000, phys_footprint_peak: null } },
          { pid: 4, auxiliary: { phys_footprint: '10000', phys_footprint_peak: 10_000 } },
        ],
      }),
    );

    expect(sample?.perPid.get(1)).toEqual({ physFootprintKb: 0, peakKb: 0 });
    expect([...(sample?.perPid.keys() ?? [])]).toEqual([1]);
  });

  it('carries a footprint far beyond any plausible machine without overflowing', () => {
    const sample = parseFootprintJson(
      fixture({
        processes: [
          {
            pid: 1,
            auxiliary: {
              phys_footprint: Number.MAX_SAFE_INTEGER,
              phys_footprint_peak: Number.MAX_SAFE_INTEGER,
            },
          },
        ],
      }),
    );

    expect(sample?.perPid.get(1)?.physFootprintKb).toBe(Math.round(Number.MAX_SAFE_INTEGER / 1024));
    expect(Number.isSafeInteger(sample?.perPid.get(1)?.physFootprintKb)).toBe(true);
  });

  it('reports swap as absent rather than zero when the summary omits it', () => {
    expect(parseFootprintJson(fixture({ summary: {} }))?.swappedKb).toBeUndefined();
  });

  it('rejects output that is not a JSON object', () => {
    expect(parseFootprintJson('{"unit":"byte"')).toBeNull();
    expect(parseFootprintJson('[]')).toBeNull();
    expect(parseFootprintJson('')).toBeNull();
  });
});

describe('readRendererFootprints', () => {
  afterEach(() => {
    setPlatform(realPlatform);
    execFileMock.mockReset();
    readFileMock.mockReset();
  });

  it('never spawns anything off macOS', async () => {
    setPlatform('linux');

    await expect(readRendererFootprints([42])).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('never spawns when there is no pid to measure', async () => {
    setPlatform('darwin');

    await expect(readRendererFootprints([])).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('asks for byte units and one -p per pid in a single invocation', async () => {
    setPlatform('darwin');
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    readFileMock.mockResolvedValue(fixture());

    const reading = await readRendererFootprints([51377, 51380]);

    expect(reading?.perPid.size).toBe(2);
    const [bin, args] = execFileMock.mock.calls[0] ?? [];
    expect(bin).toBe('/usr/bin/footprint');
    expect(args).toEqual(expect.arrayContaining(['-f', 'bytes', '-p', '51377', '-p', '51380']));
    // One spawn covers every renderer; a per-pid spawn would multiply the cost of the probe.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('fails open when the binary is missing, and still removes its temp file', async () => {
    setPlatform('darwin');
    execFileMock.mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(readRendererFootprints([42])).resolves.toBeNull();
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('fails open when the probe is killed by its timeout', async () => {
    // The runaway renderer is the slowest to walk, so a timeout must degrade rather than throw.
    setPlatform('darwin');
    execFileMock.mockRejectedValue(Object.assign(new Error('Command failed'), { killed: true }));

    await expect(readRendererFootprints([42])).resolves.toBeNull();
  });

  it('fails open when the output file cannot be read or is unrecognised', async () => {
    setPlatform('darwin');
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(readRendererFootprints([42])).resolves.toBeNull();

    readFileMock.mockResolvedValueOnce('not json');
    await expect(readRendererFootprints([42])).resolves.toBeNull();
  });
});
